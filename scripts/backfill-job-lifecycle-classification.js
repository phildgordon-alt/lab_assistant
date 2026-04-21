#!/usr/bin/env node
/**
 * One-shot backfill: populate lens_type / coating / lens_material / is_rush /
 * sla_target_days / sla_due_at on job_lifecycle rows that were written before
 * their DVI XML was available in dviJobIndex.
 *
 * Reads XML files directly from data/dvi/jobs/, parses the fields we need, and
 * UPDATEs only columns that are currently NULL — never overwrites existing data.
 *
 * Usage:
 *   node scripts/backfill-job-lifecycle-classification.js          # dry run: counts only
 *   node scripts/backfill-job-lifecycle-classification.js --apply  # commit updates
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const JOBS_DIR = path.join(ROOT, 'data', 'dvi', 'jobs');

const APPLY = process.argv.includes('--apply');

function parseXmlFields(xml) {
  const rightEye = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const leftEye  = xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/);
  const eyeXml   = rightEye ? rightEye[0] : (leftEye ? leftEye[0] : '');

  const lensBlock = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const lensXml   = lensBlock ? lensBlock[0] : '';

  const eyeAttr = (attr) => {
    const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const lensChild = (tag) => {
    const m = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };
  const lensType = eyeAttr('Type') || ((lensXml.match(/<Lens[^>]*\sType="([^"]*)"/) || [])[1] || null);
  const coating  = lensChild('Coat') || get('Coat');
  const material = eyeAttr('Material') || lensChild('Mat');
  const rush     = ((xml.match(/<RxOrder[^>]*\sRush="([^"]*)"/) || [])[1]) ||
                   ((xml.match(/<OrderData[^>]*\sRush="([^"]*)"/) || [])[1]) || null;

  return { lensType, coating, material, isRush: rush === 'Y' ? 1 : 0 };
}

function getSlaDays(lensType, coating, isRush) {
  if (isRush) return 1;
  if (lensType === 'P' && (coating === 'TRANSITIONS' || coating === 'POLARIZED' || coating === 'MIRROR')) return 3;
  if (lensType === 'P') return 2;
  if (coating === 'TRANSITIONS' || coating === 'POLARIZED') return 2;
  if (lensType === 'S' && (coating === 'HARD_COAT' || coating === 'HARD COAT')) return 1;
  if (lensType === 'S') return 2;
  return 3;
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }
  if (!fs.existsSync(JOBS_DIR)) { console.error('Jobs dir not found:', JOBS_DIR); process.exit(1); }

  const db = new Database(DB_PATH);

  const candidates = db.prepare(`
    SELECT job_id, lens_type, coating, lens_material, is_rush, entered_lab_at, sla_target_days
    FROM job_lifecycle
    WHERE lens_type IS NULL OR coating IS NULL OR lens_material IS NULL
  `).all();

  console.log(`[backfill] ${candidates.length} job_lifecycle rows need classification (lens_type/coating/lens_material NULL)`);
  console.log(`[backfill] Mode: ${APPLY ? 'APPLY (commit)' : 'DRY RUN (no writes — pass --apply to commit)'}`);

  const update = db.prepare(`
    UPDATE job_lifecycle
    SET lens_type       = COALESCE(lens_type, @lens_type),
        coating         = COALESCE(coating, @coating),
        lens_material   = COALESCE(lens_material, @lens_material),
        is_rush         = CASE WHEN is_rush = 0 AND @is_rush = 1 THEN 1 ELSE is_rush END,
        sla_target_days = CASE WHEN lens_type IS NULL AND @lens_type IS NOT NULL THEN @sla_target_days ELSE sla_target_days END,
        sla_due_at      = CASE WHEN lens_type IS NULL AND @lens_type IS NOT NULL THEN entered_lab_at + (@sla_target_days * 86400000) ELSE sla_due_at END,
        updated_at      = strftime('%s','now') * 1000
    WHERE job_id = @job_id
  `);

  const stats = { xmlFound: 0, xmlMissing: 0, xmlUnparseable: 0, updated: 0, noop: 0, byType: {} };
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const xmlPath = path.join(JOBS_DIR, `${row.job_id}.xml`);
      let raw;
      try { raw = fs.readFileSync(xmlPath, 'utf8'); }
      catch { stats.xmlMissing++; continue; }
      stats.xmlFound++;

      let parsed;
      try { parsed = parseXmlFields(raw); }
      catch { stats.xmlUnparseable++; continue; }

      // Nothing to fill — skip
      const needsLens = !row.lens_type && parsed.lensType;
      const needsCoat = !row.coating && parsed.coating;
      const needsMat  = !row.lens_material && parsed.material;
      const needsRush = row.is_rush === 0 && parsed.isRush === 1;
      if (!needsLens && !needsCoat && !needsMat && !needsRush) { stats.noop++; continue; }

      const effectiveLensType = row.lens_type || parsed.lensType;
      const effectiveCoating  = row.coating || parsed.coating;
      const effectiveRush     = row.is_rush === 1 || parsed.isRush === 1;
      const slaDays = getSlaDays(effectiveLensType, effectiveCoating, effectiveRush);

      if (APPLY) {
        update.run({
          job_id: row.job_id,
          lens_type: parsed.lensType,
          coating: parsed.coating,
          lens_material: parsed.material,
          is_rush: parsed.isRush,
          sla_target_days: slaDays,
        });
      }
      stats.updated++;
      if (parsed.lensType) stats.byType[parsed.lensType] = (stats.byType[parsed.lensType] || 0) + 1;
    }
  });
  tx(candidates);

  console.log(`[backfill] XML files found: ${stats.xmlFound}`);
  console.log(`[backfill] XML missing for row: ${stats.xmlMissing}`);
  console.log(`[backfill] XML unparseable: ${stats.xmlUnparseable}`);
  console.log(`[backfill] Rows updated${APPLY ? '' : ' (would update)'}: ${stats.updated}`);
  console.log(`[backfill] Rows already populated: ${stats.noop}`);
  console.log(`[backfill] New classifications by type:`, stats.byType);

  if (APPLY) {
    const after = db.prepare(`SELECT lens_type, COUNT(*) AS n FROM job_lifecycle GROUP BY lens_type ORDER BY n DESC`).all();
    console.log(`[backfill] Post-apply lens_type distribution:`);
    for (const r of after) console.log(`  ${r.lens_type || '(null)'}: ${r.n}`);
  }

  db.close();
}

main();
