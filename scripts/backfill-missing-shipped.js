#!/usr/bin/env node
'use strict';

// One-shot backfill for SHIPLOG XMLs that are sitting on the DVI SMB share
// but never made it into `dvi_shipped_jobs`.
//
// Why this exists: oven-timer-server.js:774-796 ('file' event handler) has
// branches for `evt.sync === 'jobs'` and `'breakage'` but NO branch for
// `'shipped'`. Combined with silently-swallowed errors in loadShippedIndex
// (oven-timer-server.js:602, :606) and the never-retry skip
// (oven-timer-server.js:582), any XML that failed once stays missing forever.
//
// This script reads SHIPLOG XMLs directly from the SMB source (the canonical
// truth, not the local mirror), parses each, and upserts via the same
// labDb.upsertShippedJob path the live server uses. Errors are logged loudly,
// not swallowed.
//
// Safe to re-run. Idempotent — INSERT OR REPLACE keyed on invoice.
//
// After this completes, restart the Lab Server. The startup self-heal at
// oven-timer-server.js:131 will back-prop SHIPPED status into the `jobs`
// table for every newly-restored row, and aging WIP will drop accordingly.
//
// Usage:
//   node scripts/backfill-missing-shipped.js [shiplog_dir] [db_path]
// Defaults:
//   shiplog_dir = /Users/Shared/lab_assistant/data/dvi/visdir/VISION/SHIPLOG
//   db_path     = /Users/Shared/lab_assistant/data/lab_assistant.db

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SHIPLOG_DIR = process.argv[2] || '/Users/Shared/lab_assistant/data/dvi/visdir/VISION/SHIPLOG';
const DB_PATH     = process.argv[3] || '/Users/Shared/lab_assistant/data/lab_assistant.db';

// ─────────────────────────────────────────────────────────────────────────────
// XML parser — copied verbatim from server/oven-timer-server.js:334-460
// (parseDviXml). Same code path, same field extraction. If the live parser is
// ever extracted into a shared module, this script should require that module
// instead.
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
  if (!rx.R && !rx.L) {
    const rxBlocks = xml.match(/<Rx\s+Eye="([RL])">([\s\S]*?)<\/Rx>/g) || [];
    for (const block of rxBlocks) {
      const eyeMatch = block.match(/Eye="([RL])"/); if (!eyeMatch) continue;
      const eye = eyeMatch[1];
      const sph  = block.match(/<Sphere>([^<]*)<\/Sphere>/);
      const cyl  = block.match(/<Cylinder[^>]*>([^<]*)<\/Cylinder>/);
      const axis = block.match(/<Cylinder\s+Axis="([^"]*)"/);
      const pd   = block.match(/<PD>([^<]*)<\/PD>/);
      const adp  = block.match(/<Power>([^<]*)<\/Power>/);
      rx[eye] = { sphere: sph?sph[1]:null, cylinder: cyl?cyl[1]:null, axis: axis?axis[1]:null, pd: pd?pd[1]:null, add: adp?adp[1]:null };
    }
  }

  const shipDate  = getAttr('OrderData', 'ShipDate');
  const shipTime  = getAttr('OrderData', 'ShipTime');
  const entryDate = getAttr('OrderData', 'EntryDate');
  const invoice   = getAttr('OrderData', 'Invoice');
  const reference = getAttr('OrderData', 'Reference');
  const daysInLab = getAttr('RxOrder', 'DaysInLab');
  const machineId = getAttr('MegaTransfer', 'MachineID');
  const isHko = machineId === '000';
  const department = getAttr('RxOrder', 'Department');
  const jobType    = getAttr('RxOrder', 'JobType');
  const operator   = getAttr('OrderData', 'Operator');
  const entryTime  = getAttr('OrderData', 'EntryTime');
  const jobOrigin  = getAttr('OrderData', 'JobOrigin');
  const lensOpcL = leftEyeBlock ? ((leftEyeBlock[0] || '').match(/\sOPC="([^"]*)"/) || [])[1] || null : null;
  const frameUpc   = ((frameXml || '').match(/\sUPC="([^"]*)"/)      || [])[1] || null;
  const frameName  = ((frameXml || '').match(/\sName="([^"]*)"/)     || [])[1] || null;
  const frameMat   = ((frameXml || '').match(/\sMaterial="([^"]*)"/) || [])[1] || null;
  const frameColor = ((frameXml || '').match(/\sColor="([^"]*)"/)    || [])[1] || null;
  const edgeType   = ((frameXml || '').match(/\sEdgeType="([^"]*)"/) || [])[1] || null;

  return {
    status: getAttr('Job', 'Status'),
    date: get('Date'),
    shipDate, shipTime, entryDate, entryTime, invoice, reference, daysInLab,
    department, jobType, operator, jobOrigin, machineId, isHko,
    rmtInv: get('RmtInv'),
    tray: get('Tray'),
    rxNum: reference || get('RxNum'),
    patient: get('Patient'),
    origin: get('Origin'),
    coating:    getLens('Coat') || get('Coat'),
    coatType:   getAttr('Coat', 'Type'),
    lensType:   getEyeAttr('Type')     || getAttr('Lens', 'Type'),
    lensPick:   getEyeAttr('Pick')     || getAttr('Lens', 'Pick'),
    lensStyle:  getLens('Style'),
    lensOpc:    getEyeAttr('OPC')      || getLens('OPC'),
    lensOpcL,
    lensMat:    getEyeAttr('Material') || getLens('Mat'),
    lensThick:  getLens('Thick'),
    lensColor:  getLens('Color'),
    frameUpc, frameName, frameMat, frameColor,
    frameStyle: getFrame('Style'),
    frameSku:   getFrame('SKU'),
    frameMfr:   getFrame('Mfr'),
    eyeSize:    getFrame('EyeSize') || get('EyeSize'),
    bridge:     getFrame('Bridge')  || get('Bridge'),
    edge:       getFrame('Edge')    || get('Edge'),
    edgeType,
    serviceInstruction: getAttr('Service', 'Instruction'),
    rx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
console.log(`[backfill] SHIPLOG dir: ${SHIPLOG_DIR}`);
console.log(`[backfill] DB:          ${DB_PATH}`);

if (!fs.existsSync(SHIPLOG_DIR)) {
  console.error(`[backfill] FATAL: ${SHIPLOG_DIR} not found (SMB mount issue?)`);
  process.exit(1);
}

// Open DB and require the same upsertShippedJob the live server uses.
// Note: requiring server/db.js initializes prepared statements. That's fine
// for a one-shot — we won't write anything else.
const labDb = require(path.resolve(__dirname, '..', 'server', 'db.js'));

// Snapshot what's already in dvi_shipped_jobs so we only process missing rows.
console.log('[backfill] reading existing dvi_shipped_jobs invoices...');
const existing = new Set(
  labDb.db.prepare('SELECT invoice FROM dvi_shipped_jobs').all().map((r) => r.invoice)
);
console.log(`[backfill]   ${existing.size} invoices already present`);

// List SHIPLOG XML files. We use fs.readdirSync — not as fast as `find` but
// gives us deterministic ordering and handles large dirs fine on a mounted
// SMB share (readdir avoids per-file stat calls).
console.log('[backfill] listing SHIPLOG dir (this can take ~30s on SMB)...');
const t0 = Date.now();
const allFiles = fs.readdirSync(SHIPLOG_DIR).filter((f) => f.endsWith('.xml'));
console.log(`[backfill]   ${allFiles.length} XML files found in ${(Date.now() - t0) / 1000}s`);

let scanned = 0;
let alreadyHave = 0;
let imported = 0;
let parseFails = 0;
let upsertFails = 0;
let badInvoiceMismatch = 0;

const t1 = Date.now();
for (const file of allFiles) {
  scanned++;
  const fileInvoice = path.basename(file, '.xml');

  if (existing.has(fileInvoice)) {
    alreadyHave++;
    continue;
  }

  let xml;
  try {
    xml = fs.readFileSync(path.join(SHIPLOG_DIR, file), 'utf8');
  } catch (e) {
    console.error(`[backfill] read failed ${file}: ${e.message}`);
    continue;
  }

  let parsed;
  try {
    parsed = parseDviXml(xml);
  } catch (e) {
    parseFails++;
    console.error(`[backfill] parse failed ${file}: ${e.message}`);
    continue;
  }

  if (!parsed || !parsed.invoice) {
    parseFails++;
    console.error(`[backfill] parse produced no invoice for ${file}`);
    continue;
  }
  if (String(parsed.invoice) !== fileInvoice) {
    // Filename invoice doesn't match XML's OrderData/@Invoice — flag but use XML's.
    badInvoiceMismatch++;
    console.warn(`[backfill] invoice mismatch: file=${fileInvoice} xml=${parsed.invoice}`);
  }

  // Compute shippedAt timestamp same way oven-timer-server.js:588-595 does.
  const cycleDate = (xml.match(/CycleDate="([^"]*)"/) || [])[1];
  const shipDateStr = parsed.shipDate || cycleDate;
  if (shipDateStr) {
    const [mm, dd, yy] = shipDateStr.split('/');
    const [hh, min] = (parsed.shipTime || '12:00').split(':');
    if (mm && dd && yy && hh) {
      parsed.shippedAt = new Date(
        `20${yy}-${mm}-${dd}T${String(hh).padStart(2,'0')}:${String(min || 0).padStart(2,'0')}:00`
      ).getTime();
    }
    if (!parsed.shipDate) parsed.shipDate = shipDateStr;
  }
  if (parsed.entryDate) {
    const [mm, dd, yy] = parsed.entryDate.split('/');
    if (mm && dd && yy) {
      parsed.enteredAt = new Date(`20${yy}-${mm}-${dd}T00:00:00`).getTime();
    }
  }

  try {
    labDb.upsertShippedJob(parsed);
    // Dual-write to unified jobs (same pattern as live loadShippedIndex).
    try { labDb.upsertJobFromXML(parsed); } catch (e) {
      console.warn(`[backfill] dual-write to jobs failed for ${parsed.invoice}: ${e.message}`);
    }
    imported++;
    if (imported % 100 === 0) {
      console.log(`[backfill]   progress: ${imported} imported, ${alreadyHave} already had`);
    }
  } catch (e) {
    upsertFails++;
    console.error(`[backfill] upsert failed for ${parsed.invoice}: ${e.message}`);
  }
}

const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
console.log('');
console.log(`[backfill] === DONE in ${elapsed}s ===`);
console.log(`[backfill]   scanned:           ${scanned}`);
console.log(`[backfill]   already had:       ${alreadyHave}`);
console.log(`[backfill]   imported:          ${imported}`);
console.log(`[backfill]   parse failures:    ${parseFails}`);
console.log(`[backfill]   upsert failures:   ${upsertFails}`);
console.log(`[backfill]   invoice mismatch:  ${badInvoiceMismatch} (used XML's value)`);

if (imported > 0) {
  console.log('');
  console.log('[backfill] Next: restart the Lab Server. The startup self-heal will back-prop');
  console.log('[backfill] SHIPPED status into the jobs table for the newly-imported invoices.');
  console.log('[backfill]   launchctl kickstart -k gui/$(id -u)/com.paireyewear.labassistant.server');
}
