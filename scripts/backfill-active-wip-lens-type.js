#!/usr/bin/env node
/**
 * One-shot backfill: enrich `lens_type` (and the rest of the classification
 * slots) on jobs rows where status='ACTIVE' and lens_type IS NULL.
 *
 * Pairs with the new live write path: persistInboundXmlToJobsTable() in
 * oven-timer-server.js + upsertJobClassificationFromXML() in db.js. Going
 * forward, every inbound DVI XML enriches its row at sync time. This script
 * fills the historical gap (~88% of active WIP today).
 *
 * Phil's domain rule: "you can't get past picking without a lens picked from
 * Kardex" — so any active job in CUTTING/COATING/SURFACING/ASSEMBLY/SHIPPING
 * MUST have lens_type. NULL there is impossible per the lab's reality.
 *
 * Usage:
 *   node scripts/backfill-active-wip-lens-type.js           # dry run (default)
 *   node scripts/backfill-active-wip-lens-type.js --apply   # commit
 *
 * Reports:
 *   data/backfill-reports/active-wip-lens-type-<YYYY-MM-DD>.log
 *     — per-run log of jobs missing their inbound XML on disk (for separate
 *       investigation). Written in both dry-run and apply modes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const JOBS_DIR = path.join(ROOT, 'data', 'dvi', 'jobs');
const REPORTS_DIR = path.join(ROOT, 'data', 'backfill-reports');

const APPLY = process.argv.includes('--apply');

// Reuse the same parser the live server uses — keep this script in lockstep
// with parseDviXml() in oven-timer-server.js. We can't require() that file
// directly (it boots the whole server on require). Instead, inline the same
// regex extraction — kept narrow to the classification slots this script
// actually writes.
function parseDviXmlClassification(xml) {
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  const rightEyeBlock = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const leftEyeBlock  = xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/);
  const lensBlock     = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const eyeXml  = rightEyeBlock ? rightEyeBlock[0] : (leftEyeBlock ? leftEyeBlock[0] : '');
  const lensXml = lensBlock ? lensBlock[0] : '';
  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/) || xml.match(/<Frame[^>]*\/>/);
  const frameXml   = frameBlock ? frameBlock[0] : '';

  const getEyeAttr = (attr) => { const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const getLens = (tag) => {
    const a = getEyeAttr(tag); if (a) return a;
    const eyeChild = eyeXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    if (eyeChild) return eyeChild[1].trim();
    const lensChild = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return lensChild ? lensChild[1].trim() : null;
  };

  const machineId = getAttr('MegaTransfer', 'MachineID');
  const lensOpcL = leftEyeBlock ? ((leftEyeBlock[0] || '').match(/\sOPC="([^"]*)"/) || [])[1] || null : null;
  const frameUpc = ((frameXml || '').match(/\sUPC="([^"]*)"/) || [])[1] || null;
  const frameName = ((frameXml || '').match(/\sName="([^"]*)"/) || [])[1] || null;
  const frameStyle = (frameXml.match(/<Style[^>]*>([^<]*)<\/Style>/) || [])[1] || null;

  return {
    invoice:    getAttr('OrderData', 'Invoice'),
    reference:  getAttr('OrderData', 'Reference'),
    rxNum:      getAttr('OrderData', 'Reference') || get('RxNum'),
    entryDate:  getAttr('OrderData', 'EntryDate'),
    entryTime:  getAttr('OrderData', 'EntryTime'),
    department: getAttr('RxOrder', 'Department'),
    jobType:    getAttr('RxOrder', 'JobType'),
    isHko:      machineId === '000',
    lensType:   getEyeAttr('Type')     || getAttr('Lens', 'Type'),
    lensMat:    getEyeAttr('Material') || getLens('Mat'),
    lensStyle:  getLens('Style'),
    lensColor:  getLens('Color'),
    coating:    getLens('Coat')        || get('Coat'),
    coatType:   getAttr('Coat', 'Type'),
    lensOpc:    getEyeAttr('OPC')      || getLens('OPC'),
    lensOpcL,
    frameUpc, frameName, frameStyle,
  };
}

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function reportPathForToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(REPORTS_DIR, `active-wip-lens-type-${yyyy}-${mm}-${dd}.log`);
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }
  if (!fs.existsSync(JOBS_DIR)) { console.error('Jobs dir not found:', JOBS_DIR); process.exit(1); }

  // require better-sqlite3 lazily so this script doesn't crash if installed
  // standalone outside the repo.
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  const candidates = db.prepare(`
    SELECT invoice, current_stage, current_station, status
    FROM jobs
    WHERE status = 'ACTIVE' AND lens_type IS NULL
  `).all();

  console.log(`[backfill/active-wip-lens-type] candidates: ${candidates.length}`);
  console.log(`[backfill] Mode: ${APPLY ? 'APPLY (commit)' : 'DRY RUN (no writes — pass --apply to commit)'}`);

  ensureReportsDir();
  const reportPath = reportPathForToday();
  const reportLines = [
    `# active-wip-lens-type backfill — ${new Date().toISOString()}`,
    `# mode=${APPLY ? 'APPLY' : 'DRY-RUN'} candidates=${candidates.length}`,
    `# columns: invoice\tcurrent_stage\tcurrent_station\treason`,
    '',
  ];

  // Mirror of upsertJobClassificationFromXML — used for dry-run counting AND
  // for applying writes. We can't require server/db.js (it opens the prod DB
  // on require with WAL flags, which would conflict with this script's own
  // handle). Inline the same UPSERT body verbatim — keep in lockstep.
  const upsert = db.prepare(`
    INSERT INTO jobs (invoice, reference, rx_number, entry_date, entry_time,
                      department, job_type, is_hko,
                      lens_type, lens_material, lens_style, lens_color,
                      coating, coat_type, lens_opc_r, lens_opc_l,
                      frame_upc, frame_name, frame_style,
                      status, current_stage, updated_at)
    VALUES (@invoice, @reference, @rx_number, @entry_date, @entry_time,
            @department, @job_type, @is_hko,
            @lens_type, @lens_material, @lens_style, @lens_color,
            @coating, @coat_type, @lens_opc_r, @lens_opc_l,
            @frame_upc, @frame_name, @frame_style,
            'ACTIVE', 'INCOMING', datetime('now'))
    ON CONFLICT(invoice) DO UPDATE SET
      reference     = COALESCE(jobs.reference,     excluded.reference),
      rx_number     = COALESCE(jobs.rx_number,     excluded.rx_number),
      entry_date    = COALESCE(jobs.entry_date,    excluded.entry_date),
      entry_time    = COALESCE(jobs.entry_time,    excluded.entry_time),
      department    = COALESCE(jobs.department,    excluded.department),
      job_type      = COALESCE(jobs.job_type,      excluded.job_type),
      is_hko        = MAX(jobs.is_hko, excluded.is_hko),
      lens_type     = COALESCE(jobs.lens_type,     excluded.lens_type),
      lens_material = COALESCE(jobs.lens_material, excluded.lens_material),
      lens_style    = COALESCE(jobs.lens_style,    excluded.lens_style),
      lens_color    = COALESCE(jobs.lens_color,    excluded.lens_color),
      coating       = COALESCE(jobs.coating,       excluded.coating),
      coat_type     = COALESCE(jobs.coat_type,     excluded.coat_type),
      lens_opc_r    = COALESCE(jobs.lens_opc_r,    excluded.lens_opc_r),
      lens_opc_l    = COALESCE(jobs.lens_opc_l,    excluded.lens_opc_l),
      frame_upc     = COALESCE(jobs.frame_upc,     excluded.frame_upc),
      frame_name    = COALESCE(jobs.frame_name,    excluded.frame_name),
      frame_style   = COALESCE(jobs.frame_style,   excluded.frame_style),
      updated_at    = datetime('now')
  `);

  const stats = {
    examined: 0,
    wouldFill: 0,         // dry-run: would have writeable lens_type
    filled: 0,            // apply: actually filled
    missingXml: 0,
    parseError: 0,
    noLensTypeInXml: 0,
    errors: 0,
    byType: {},
  };

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      stats.examined++;
      if (stats.examined % 100 === 0) {
        process.stdout.write(`\r  progress: ${stats.examined}/${rows.length}`);
      }
      const xmlPath = path.join(JOBS_DIR, `${row.invoice}.xml`);
      let raw;
      try { raw = fs.readFileSync(xmlPath, 'utf8'); }
      catch {
        stats.missingXml++;
        reportLines.push(`${row.invoice}\t${row.current_stage || ''}\t${row.current_station || ''}\tmissing-xml`);
        continue;
      }
      let parsed;
      try { parsed = parseDviXmlClassification(raw); }
      catch (e) {
        stats.parseError++;
        reportLines.push(`${row.invoice}\t${row.current_stage || ''}\t${row.current_station || ''}\tparse-error:${e.message}`);
        continue;
      }
      if (!parsed.lensType) {
        stats.noLensTypeInXml++;
        reportLines.push(`${row.invoice}\t${row.current_stage || ''}\t${row.current_station || ''}\txml-has-no-lensType`);
        continue;
      }
      stats.wouldFill++;
      stats.byType[parsed.lensType] = (stats.byType[parsed.lensType] || 0) + 1;

      if (APPLY) {
        try {
          upsert.run({
            invoice:       row.invoice,
            reference:     parsed.reference || null,
            rx_number:     parsed.rxNum || null,
            entry_date:    parsed.entryDate || null,
            entry_time:    parsed.entryTime || null,
            department:    parsed.department || null,
            job_type:      parsed.jobType || null,
            is_hko:        parsed.isHko ? 1 : 0,
            lens_type:     parsed.lensType || null,
            lens_material: parsed.lensMat || null,
            lens_style:    parsed.lensStyle || null,
            lens_color:    parsed.lensColor || null,
            coating:       parsed.coating || null,
            coat_type:     parsed.coatType || null,
            lens_opc_r:    parsed.lensOpc || null,
            lens_opc_l:    parsed.lensOpcL || null,
            frame_upc:     parsed.frameUpc || null,
            frame_name:    parsed.frameName || null,
            frame_style:   parsed.frameStyle || null,
          });
          stats.filled++;
        } catch (e) {
          stats.errors++;
          reportLines.push(`${row.invoice}\t${row.current_stage || ''}\t${row.current_station || ''}\twrite-error:${e.message}`);
        }
      }
    }
  });
  tx(candidates);
  process.stdout.write('\n');

  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n');
  console.log(`[backfill] wrote report: ${reportPath}`);

  if (APPLY) {
    console.log(`[backfill] examined: ${stats.examined}`);
    console.log(`[backfill] filled: ${stats.filled}`);
    console.log(`[backfill] missing xml: ${stats.missingXml}`);
    console.log(`[backfill] xml-has-no-lensType: ${stats.noLensTypeInXml}`);
    console.log(`[backfill] parse errors: ${stats.parseError}`);
    console.log(`[backfill] write errors: ${stats.errors}`);
    console.log(`[backfill] new lens_type distribution:`, stats.byType);
    const remaining = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs WHERE status='ACTIVE' AND lens_type IS NULL
    `).get().n;
    console.log(`[backfill] post-apply ACTIVE rows still NULL lens_type: ${remaining}`);
  } else {
    console.log(`[backfill] DRY RUN — would fill ${stats.wouldFill} jobs, ${stats.missingXml} missing XML, ${stats.noLensTypeInXml} XML present but no lensType, ${stats.parseError} parse errors.`);
    console.log(`[backfill] new lens_type distribution (would-be):`, stats.byType);
    console.log(`[backfill] re-run with --apply to commit.`);
  }

  db.close();
}

main();
