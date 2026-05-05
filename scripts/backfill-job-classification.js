#!/usr/bin/env node
'use strict';

// One-shot backfill for classification fields (lens_type, lens_style,
// lens_material, frame_*, RX, etc.) on jobs rows that are missing them.
//
// Why this exists:
//   - 6 days (Apr 30 - May 5) of upsertJobFromXML silently failing meant
//     the dual-write to jobs from SHIPLOG XMLs never happened. Plus, the
//     'shipped' event handler in oven-timer-server.js was missing entirely,
//     so SHIPLOG XMLs that DID arrive locally never triggered classification
//     enrichment. Both fixed in c85881e and ebad34e respectively.
//   - Net result: many jobs rows have NULL lens_type / lens_style despite
//     a perfectly valid per-job XML sitting on the SMB share.
//
// What this does:
//   - For every invoice in jobs that has NULL lens_type, find the matching
//     <invoice>.xml on the SMB source (visdir/VISION/Q), parse it, and call
//     labDb.upsertJobClassificationFromXML to enrich. The upsert is
//     COALESCE-style (only fills NULL slots), so it's safe and idempotent.
//   - Logs every failure loudly. No silent /* skip bad files */.
//
// Usage:
//   node scripts/backfill-job-classification.js [jobs_xml_dir] [db_path]
// Defaults:
//   jobs_xml_dir = /Users/Shared/lab_assistant/data/dvi/visdir/VISION/Q
//   db_path      = /Users/Shared/lab_assistant/data/lab_assistant.db

const fs = require('fs');
const path = require('path');

// XML candidates are checked in order. The local mirror at data/dvi/jobs/ is
// the long-term store (~63K XMLs going back months) and almost always has
// the file. The SMB VISION/Q dir is the live working dir; DVI cycles files
// out of it after they're processed, so old invoices don't exist there.
// SHIPLOG is the post-ship XML — used as a final fallback for SHIPPED rows
// whose original Q-side XML has been archived.
const XML_CANDIDATE_DIRS = [
  '/Users/Shared/lab_assistant/data/dvi/jobs',                    // local mirror, primary
  '/Users/Shared/lab_assistant/data/dvi/visdir/VISION/Q',         // SMB live, fallback
  '/Users/Shared/lab_assistant/data/dvi/shipped',                 // local SHIPLOG mirror
  '/Users/Shared/lab_assistant/data/dvi/visdir/VISION/SHIPLOG',   // SMB SHIPLOG, last resort
];

// Optional CLI arg overrides the candidate list with a single path.
const OVERRIDE_DIR = process.argv[2];
const DB_PATH      = process.argv[3] || '/Users/Shared/lab_assistant/data/lab_assistant.db';
const dirsToTry = OVERRIDE_DIR ? [OVERRIDE_DIR] : XML_CANDIDATE_DIRS;

// ─────────────────────────────────────────────────────────────────────────────
// XML parser — copied from server/oven-timer-server.js parseDviXml. Same code
// path as the live server. If that parser is ever extracted into a shared
// module, this script should require it instead.
// ─────────────────────────────────────────────────────────────────────────────
function parseDviXml(xml) {
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };

  const rightEyeBlock = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const leftEyeBlock  = xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/);
  const lensBlock     = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const eyeXml  = rightEyeBlock ? rightEyeBlock[0] : (leftEyeBlock ? leftEyeBlock[0] : '');
  const lensXml = lensBlock ? lensBlock[0] : '';
  const getEyeAttr = (attr) => { const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const getLens = (tag) => {
    const a = getEyeAttr(tag); if (a) return a;
    const c = eyeXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); if (c) return c[1].trim();
    const l = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return l ? l[1].trim() : null;
  };

  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/) || xml.match(/<Frame[^>]*\/>/);
  const frameXml = frameBlock ? frameBlock[0] : '';
  const getFrame = (tag) => { const m = frameXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  const rx = {};
  for (const { eye, block } of [
    { eye: 'R', block: rightEyeBlock ? rightEyeBlock[0] : null },
    { eye: 'L', block: leftEyeBlock  ? leftEyeBlock[0]  : null },
  ]) {
    if (!block) continue;
    const attr = (n) => { const m = block.match(new RegExp(`\\s${n}="([^"]*)"`)); return m ? m[1] : null; };
    rx[eye] = {
      sphere: attr('Sphere'), cylinder: attr('Cylinder'),
      axis: attr('CylAxis') || attr('Axis'),
      pd: attr('DistancePD') || attr('PD'),
      add: attr('Add'),
    };
  }

  const shipDate  = getAttr('OrderData', 'ShipDate');
  const shipTime  = getAttr('OrderData', 'ShipTime');
  const entryDate = getAttr('OrderData', 'EntryDate');
  const invoice   = getAttr('OrderData', 'Invoice');
  const reference = getAttr('OrderData', 'Reference');
  const machineId = getAttr('MegaTransfer', 'MachineID');
  const isHko = machineId === '000';
  const department = getAttr('RxOrder', 'Department');
  const jobType    = getAttr('RxOrder', 'JobType');
  const operator   = getAttr('OrderData', 'Operator');
  const lensOpcL = leftEyeBlock ? ((leftEyeBlock[0] || '').match(/\sOPC="([^"]*)"/) || [])[1] || null : null;
  const frameUpc   = ((frameXml || '').match(/\sUPC="([^"]*)"/)      || [])[1] || null;
  const frameName  = ((frameXml || '').match(/\sName="([^"]*)"/)     || [])[1] || null;
  const frameMat   = ((frameXml || '').match(/\sMaterial="([^"]*)"/) || [])[1] || null;
  const frameColor = ((frameXml || '').match(/\sColor="([^"]*)"/)    || [])[1] || null;

  return {
    invoice, reference, shipDate, shipTime, entryDate, department, jobType, operator,
    machineId, isHko,
    tray: get('Tray'),
    rxNum: reference || get('RxNum'),
    coating:    getLens('Coat') || get('Coat'),
    coatType:   getAttr('Coat', 'Type'),
    lensType:   getEyeAttr('Type')     || getAttr('Lens', 'Type'),
    lensPick:   getEyeAttr('Pick')     || getAttr('Lens', 'Pick'),
    lensStyle:  getLens('Style'),
    lensOpc:    getEyeAttr('OPC')      || getLens('OPC'),
    lensOpcL,
    lensMat:    getEyeAttr('Material') || getLens('Mat'),
    lensColor:  getLens('Color'),
    frameUpc, frameName, frameMat, frameColor,
    frameStyle: getFrame('Style'),
    frameSku:   getFrame('SKU'),
    frameMfr:   getFrame('Mfr'),
    eyeSize:    getFrame('EyeSize') || get('EyeSize'),
    bridge:     getFrame('Bridge')  || get('Bridge'),
    edge:       getFrame('Edge')    || get('Edge'),
    rx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`[backfill-classification] DB: ${DB_PATH}`);
console.log(`[backfill-classification] XML candidates (checked in order):`);
for (const d of dirsToTry) {
  console.log(`[backfill-classification]   ${fs.existsSync(d) ? '✓' : '✗'} ${d}`);
}
const anyExists = dirsToTry.some((d) => fs.existsSync(d));
if (!anyExists) {
  console.error(`[backfill-classification] FATAL: none of the candidate dirs exist`);
  process.exit(1);
}

const labDb = require(path.resolve(__dirname, '..', 'server', 'db.js'));

// Find invoices that need enrichment. Includes SHIPPED rows because the
// 6-day upsertJobFromXML silent failure (Apr 30 - May 5) left jobs.lens_type
// NULL on every SHIPLOG-processed row in that window. dvi_shipped_jobs got
// the data; jobs did not.
console.log('[backfill-classification] querying invoices missing lens_type...');
const targets = labDb.db.prepare(`
  SELECT invoice
  FROM jobs
  WHERE (lens_type IS NULL OR lens_type = '')
  ORDER BY invoice
`).all().map((r) => r.invoice);
console.log(`[backfill-classification]   ${targets.length} invoices need enrichment`);

if (targets.length === 0) {
  console.log('[backfill-classification] nothing to do');
  process.exit(0);
}

let scanned = 0;
let xmlMissing = 0;
let parseFails = 0;
let upsertFails = 0;
let imported = 0;
const sourceCounts = new Map(); // dir -> hits, for diagnostics

const t0 = Date.now();
for (const invoice of targets) {
  scanned++;
  let filePath = null;
  for (const d of dirsToTry) {
    const p = path.join(d, `${invoice}.xml`);
    if (fs.existsSync(p)) { filePath = p; sourceCounts.set(d, (sourceCounts.get(d) || 0) + 1); break; }
  }
  if (!filePath) {
    xmlMissing++;
    if (xmlMissing <= 5 || xmlMissing % 50 === 0) {
      console.warn(`[backfill-classification] XML not found for ${invoice} in any candidate dir`);
    }
    continue;
  }

  let xml;
  try { xml = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    console.error(`[backfill-classification] read failed ${invoice}: ${e.message}`);
    continue;
  }

  let parsed;
  try { parsed = parseDviXml(xml); }
  catch (e) {
    parseFails++;
    console.error(`[backfill-classification] parse failed ${invoice}: ${e.message}`);
    continue;
  }

  if (!parsed || !parsed.invoice) {
    parseFails++;
    console.error(`[backfill-classification] parse produced no invoice for ${invoice}`);
    continue;
  }

  try {
    labDb.upsertJobClassificationFromXML(parsed);
    imported++;
    if (imported % 25 === 0) {
      console.log(`[backfill-classification]   progress: ${imported}/${targets.length} enriched`);
    }
  } catch (e) {
    upsertFails++;
    console.error(`[backfill-classification] upsert failed ${invoice}: ${e.message}`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
console.log(`[backfill-classification] === DONE in ${elapsed}s ===`);
console.log(`[backfill-classification]   targeted:        ${targets.length}`);
console.log(`[backfill-classification]   enriched:        ${imported}`);
console.log(`[backfill-classification]   XML not found:   ${xmlMissing}`);
console.log(`[backfill-classification]   parse failures:  ${parseFails}`);
console.log(`[backfill-classification]   upsert failures: ${upsertFails}`);
if (sourceCounts.size > 0) {
  console.log(`[backfill-classification]   sources used:`);
  for (const [d, n] of sourceCounts) console.log(`[backfill-classification]     ${n.toString().padStart(6)}  ${d}`);
}

if (imported > 0) {
  console.log('');
  console.log('[backfill-classification] Aging dashboard "By Lens Type" should refresh on next poll (60s).');
}
