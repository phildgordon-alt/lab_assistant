#!/usr/bin/env node
/**
 * One-shot backfill: populate lens_type / coating / lens_material / frame_name /
 * rush / days_in_lab fields on `jobs` table rows, AND normalize `status` for
 * jobs whose current_stage is CANCELED or SHIPPED (or whose invoice is in
 * dvi_shipped_jobs).
 *
 * Root cause: `upsertJobFromTrace` (db.js:2620) does not include classification
 * columns in its INSERT — trace-driven rows are created with lens_type=null
 * forever. Only `upsertJobFromXML` sets lens_type, and that path writes
 * status='SHIPPED'. So active WIP rows are always unclassified until this
 * backfill (or future upserts carrying XML enrichment) runs.
 *
 * Usage:
 *   node scripts/backfill-jobs-classification.js          # dry run
 *   node scripts/backfill-jobs-classification.js --apply  # commit
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
  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/) || xml.match(/<Frame[^>]*\/>/);
  const frameXml   = frameBlock ? frameBlock[0] : '';

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
  const frameAttr = (attr) => {
    const m = frameXml.match(new RegExp(`\\s${attr}="([^"]*)"`));
    return m ? m[1] : null;
  };

  const lensType = eyeAttr('Type') || ((lensXml.match(/<Lens[^>]*\sType="([^"]*)"/) || [])[1] || null);
  const coating  = lensChild('Coat') || get('Coat');
  const material = eyeAttr('Material') || lensChild('Mat');
  const rush     = ((xml.match(/<RxOrder[^>]*\sRush="([^"]*)"/) || [])[1]) ||
                   ((xml.match(/<OrderData[^>]*\sRush="([^"]*)"/) || [])[1]) || null;
  const frameName = frameAttr('Name');
  const lensStyle = lensChild('Style') || eyeAttr('Style');

  return { lensType, coating, material, rush, frameName, lensStyle };
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }
  if (!fs.existsSync(JOBS_DIR)) { console.error('Jobs dir not found:', JOBS_DIR); process.exit(1); }

  const db = new Database(DB_PATH);

  // ─── Part 1: status normalization ─────────────────────────────────────────
  // CANCELED-stage rows should have status='CANCELED', not 'ACTIVE'.
  // SHIPPED-stage rows or rows in dvi_shipped_jobs should be status='SHIPPED'.
  const canceledCount = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE current_stage = 'CANCELED' AND status IN ('ACTIVE','Active')
  `).get().n;
  const shippedStageCount = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE current_stage IN ('SHIPPED','COMPLETE') AND status IN ('ACTIVE','Active')
  `).get().n;
  let dviShippedCount = 0;
  try {
    dviShippedCount = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND invoice IN (SELECT invoice FROM dvi_shipped_jobs)
    `).get().n;
  } catch (e) { /* dvi_shipped_jobs may not exist */ }

  console.log(`[backfill/status] CANCELED-stage with status=ACTIVE: ${canceledCount}`);
  console.log(`[backfill/status] SHIPPED-stage with status=ACTIVE: ${shippedStageCount}`);
  console.log(`[backfill/status] in dvi_shipped_jobs with status=ACTIVE: ${dviShippedCount}`);

  // ─── Part 2: classification backfill ──────────────────────────────────────
  const candidates = db.prepare(`
    SELECT invoice, lens_type, coating, lens_material, frame_name, rush, lens_style
    FROM jobs
    WHERE lens_type IS NULL OR coating IS NULL OR lens_material IS NULL
  `).all();

  console.log(`[backfill/class] ${candidates.length} jobs rows need classification`);
  console.log(`[backfill] Mode: ${APPLY ? 'APPLY (commit)' : 'DRY RUN (no writes — pass --apply to commit)'}`);

  const stats = { xmlFound: 0, xmlMissing: 0, updated: 0, noop: 0, byType: {} };

  const update = db.prepare(`
    UPDATE jobs
    SET lens_type     = COALESCE(lens_type, @lens_type),
        coating       = COALESCE(coating, @coating),
        lens_material = COALESCE(lens_material, @lens_material),
        lens_style    = COALESCE(lens_style, @lens_style),
        frame_name    = COALESCE(frame_name, @frame_name),
        rush          = CASE WHEN rush IS NULL OR rush = 'N' THEN COALESCE(@rush, rush) ELSE rush END,
        updated_at    = datetime('now')
    WHERE invoice = @invoice
  `);

  if (APPLY) {
    // Status normalization first (small, fast)
    const fixCanceled = db.prepare(`UPDATE jobs SET status='CANCELED', updated_at=datetime('now') WHERE current_stage='CANCELED' AND status IN ('ACTIVE','Active')`);
    const fixShippedStage = db.prepare(`UPDATE jobs SET status='SHIPPED', updated_at=datetime('now') WHERE current_stage IN ('SHIPPED','COMPLETE') AND status IN ('ACTIVE','Active')`);
    const fixShippedFromDvi = db.prepare(`UPDATE jobs SET status='SHIPPED', updated_at=datetime('now') WHERE status IN ('ACTIVE','Active') AND invoice IN (SELECT invoice FROM dvi_shipped_jobs)`);
    db.transaction(() => {
      fixCanceled.run();
      fixShippedStage.run();
      try { fixShippedFromDvi.run(); } catch {}
    })();
  }

  // Classification backfill
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const xmlPath = path.join(JOBS_DIR, `${row.invoice}.xml`);
      let raw;
      try { raw = fs.readFileSync(xmlPath, 'utf8'); }
      catch { stats.xmlMissing++; continue; }
      stats.xmlFound++;

      let parsed;
      try { parsed = parseXmlFields(raw); }
      catch { continue; }

      const needsLens  = !row.lens_type && parsed.lensType;
      const needsCoat  = !row.coating && parsed.coating;
      const needsMat   = !row.lens_material && parsed.material;
      const needsStyle = !row.lens_style && parsed.lensStyle;
      const needsFrame = !row.frame_name && parsed.frameName;
      if (!needsLens && !needsCoat && !needsMat && !needsStyle && !needsFrame) { stats.noop++; continue; }

      if (APPLY) {
        update.run({
          invoice: row.invoice,
          lens_type: parsed.lensType,
          coating: parsed.coating,
          lens_material: parsed.material,
          lens_style: parsed.lensStyle,
          frame_name: parsed.frameName,
          rush: parsed.rush,
        });
      }
      stats.updated++;
      if (parsed.lensType) stats.byType[parsed.lensType] = (stats.byType[parsed.lensType] || 0) + 1;
    }
  });
  tx(candidates);

  console.log(`[backfill/class] XML files found: ${stats.xmlFound}`);
  console.log(`[backfill/class] XML missing: ${stats.xmlMissing}`);
  console.log(`[backfill/class] Rows updated${APPLY ? '' : ' (would update)'}: ${stats.updated}`);
  console.log(`[backfill/class] Rows already populated: ${stats.noop}`);
  console.log(`[backfill/class] New lens_type classifications:`, stats.byType);

  if (APPLY) {
    const dist = db.prepare(`
      SELECT COALESCE(lens_type,'(null)') AS lens_type, status, COUNT(*) AS n
      FROM jobs
      WHERE status IN ('ACTIVE','Active')
      GROUP BY lens_type, status
      ORDER BY n DESC
    `).all();
    console.log(`\n[backfill] Post-apply ACTIVE jobs by lens_type:`);
    for (const r of dist) console.log(`  ${r.lens_type} (${r.status}): ${r.n}`);
  }

  db.close();
}

main();
