#!/usr/bin/env node
/**
 * Backfill dvi_shipped_jobs table from all shipped XML files.
 * One-time script — run after deploying the new schema.
 * Safe to re-run (INSERT OR REPLACE).
 *
 * Usage: cd /Users/Shared/lab_assistant && node backfill_shipped_xml.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'lab_assistant.db');
const SHIPPED_DIR = path.join(__dirname, 'data', 'dvi', 'shipped');

// Import parseDviXml from the server (reuse the same parser)
// We need to load it without starting the server, so we extract just the function
const serverCode = fs.readFileSync(path.join(__dirname, 'server', 'oven-timer-server.js'), 'utf8');

// Instead of extracting, just use the db module which has the upsert
const db = new Database(DB_PATH);

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS dvi_shipped_jobs (
    invoice TEXT PRIMARY KEY, reference TEXT, tray TEXT, rx_number TEXT,
    entry_date TEXT, entry_time TEXT, ship_date TEXT, ship_time TEXT, days_in_lab INTEGER,
    department TEXT, job_type TEXT, operator TEXT, job_origin TEXT, machine_id TEXT, is_hko INTEGER DEFAULT 0,
    lens_opc_r TEXT, lens_opc_l TEXT, lens_style TEXT, lens_material TEXT, lens_type TEXT, lens_pick TEXT, lens_color TEXT,
    coating TEXT, coat_type TEXT,
    frame_upc TEXT, frame_name TEXT, frame_style TEXT, frame_sku TEXT, frame_mfr TEXT, frame_color TEXT,
    eye_size TEXT, bridge TEXT, edge_type TEXT,
    rx_r_sphere TEXT, rx_r_cylinder TEXT, rx_r_axis TEXT, rx_r_pd TEXT, rx_r_add TEXT,
    rx_l_sphere TEXT, rx_l_cylinder TEXT, rx_l_axis TEXT, rx_l_pd TEXT, rx_l_add TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  )
`);

// Inline parser (same logic as parseDviXml in oven-timer-server.js)
function parseXml(xml) {
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const rightEyeBlock = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const leftEyeBlock = xml.match(/<LeftEye[^>]*(?:\/>|>[\s\S]*?<\/LeftEye>)/);
  const lensBlock = xml.match(/<Lens[^>]*>([\s\S]*?)<\/Lens>/);
  const eyeXml = rightEyeBlock ? rightEyeBlock[0] : (leftEyeBlock ? leftEyeBlock[0] : '');
  const lensXml = lensBlock ? lensBlock[0] : '';
  const getEyeAttr = (attr) => { const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const getLens = (tag) => {
    const attrVal = getEyeAttr(tag);
    if (attrVal) return attrVal;
    const eyeChild = eyeXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    if (eyeChild) return eyeChild[1].trim();
    const lensChild = lensXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return lensChild ? lensChild[1].trim() : null;
  };
  const frameBlock = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/) || xml.match(/<Frame[^>]*\/>/);
  const frameXml = frameBlock ? frameBlock[0] : '';
  const getFrame = (tag) => { const m = frameXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  // Rx data
  const rx = {};
  for (const { eye, block } of [
    { eye: 'R', block: rightEyeBlock ? rightEyeBlock[0] : null },
    { eye: 'L', block: leftEyeBlock ? leftEyeBlock[0] : null },
  ]) {
    if (!block) continue;
    const attr = (name) => { const m = block.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
    rx[eye] = { sphere: attr('Sphere'), cylinder: attr('Cylinder'), axis: attr('CylAxis') || attr('Axis'), pd: attr('DistancePD') || attr('PD'), add: attr('Add') };
  }

  const machineId = getAttr('MegaTransfer', 'MachineID');
  const lensOpcL = leftEyeBlock ? ((leftEyeBlock[0] || '').match(/\sOPC="([^"]*)"/) || [])[1] || null : null;
  const frameUpc = ((frameXml || '').match(/\sUPC="([^"]*)"/) || [])[1] || null;
  const frameName = ((frameXml || '').match(/\sName="([^"]*)"/) || [])[1] || null;
  const frameMat = ((frameXml || '').match(/\sMaterial="([^"]*)"/) || [])[1] || null;
  const frameColor = ((frameXml || '').match(/\sColor="([^"]*)"/) || [])[1] || null;
  const edgeType = ((frameXml || '').match(/\sEdgeType="([^"]*)"/) || [])[1] || null;

  return {
    shipDate: getAttr('OrderData', 'ShipDate'),
    shipTime: getAttr('OrderData', 'ShipTime'),
    entryDate: getAttr('OrderData', 'EntryDate'),
    entryTime: getAttr('OrderData', 'EntryTime'),
    invoice: getAttr('OrderData', 'Invoice'),
    reference: getAttr('OrderData', 'Reference'),
    tray: get('Tray'),
    rxNum: getAttr('OrderData', 'RxNumber'),
    daysInLab: getAttr('RxOrder', 'DaysInLab'),
    department: getAttr('RxOrder', 'Department'),
    jobType: getAttr('RxOrder', 'JobType'),
    operator: getAttr('OrderData', 'Operator'),
    jobOrigin: getAttr('OrderData', 'JobOrigin'),
    machineId,
    isHko: machineId === '000',
    coating: getLens('Coat') || get('Coat'),
    coatType: getAttr('Coat', 'Type'),
    lensType: getEyeAttr('Type') || getAttr('Lens', 'Type'),
    lensPick: getEyeAttr('Pick') || getAttr('Lens', 'Pick'),
    lensStyle: getLens('Style'),
    lensOpc: getEyeAttr('OPC') || getLens('OPC'),
    lensOpcL,
    lensMat: getEyeAttr('Material') || getLens('Mat'),
    lensColor: getLens('Color'),
    frameStyle: getFrame('Style'),
    frameSku: getFrame('SKU'),
    frameMfr: getFrame('Mfr'),
    frameUpc, frameName, frameMat, frameColor, edgeType,
    eyeSize: getFrame('EyeSize') || get('EyeSize'),
    bridge: getFrame('Bridge') || get('Bridge'),
    rx,
  };
}

function convertDate(d) {
  if (!d) return null;
  const m = d.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `20${m[3]}-${m[1]}-${m[2]}` : d;
}

const stmt = db.prepare(`
  INSERT OR REPLACE INTO dvi_shipped_jobs
  (invoice, reference, tray, rx_number, entry_date, entry_time, ship_date, ship_time, days_in_lab,
   department, job_type, operator, job_origin, machine_id, is_hko,
   lens_opc_r, lens_opc_l, lens_style, lens_material, lens_type, lens_pick, lens_color,
   coating, coat_type, frame_upc, frame_name, frame_style, frame_sku, frame_mfr, frame_color,
   eye_size, bridge, edge_type,
   rx_r_sphere, rx_r_cylinder, rx_r_axis, rx_r_pd, rx_r_add,
   rx_l_sphere, rx_l_cylinder, rx_l_axis, rx_l_pd, rx_l_add)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

console.log(`Scanning ${SHIPPED_DIR}...`);
const files = fs.readdirSync(SHIPPED_DIR).filter(f => f.endsWith('.xml'));
console.log(`Found ${files.length} XML files`);

let inserted = 0, errors = 0;
const start = Date.now();

const run = db.transaction(() => {
  for (const file of files) {
    try {
      const invoice = path.basename(file, '.xml');
      const xml = fs.readFileSync(path.join(SHIPPED_DIR, file), 'utf8');
      const p = parseXml(xml);
      stmt.run(
        p.invoice || invoice, p.reference, p.tray, p.rxNum,
        convertDate(p.entryDate), p.entryTime, convertDate(p.shipDate), p.shipTime,
        parseInt(p.daysInLab) || null,
        p.department, p.jobType, p.operator, p.jobOrigin, p.machineId, p.isHko ? 1 : 0,
        p.lensOpc, p.lensOpcL, p.lensStyle, p.lensMat, p.lensType, p.lensPick, p.lensColor,
        p.coating, p.coatType, p.frameUpc, p.frameName, p.frameStyle, p.frameSku, p.frameMfr, p.frameColor,
        p.eyeSize, p.bridge, p.edgeType,
        p.rx?.R?.sphere, p.rx?.R?.cylinder, p.rx?.R?.axis, p.rx?.R?.pd, p.rx?.R?.add,
        p.rx?.L?.sphere, p.rx?.L?.cylinder, p.rx?.L?.axis, p.rx?.L?.pd, p.rx?.L?.add
      );
      inserted++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`  Error ${file}: ${e.message}`);
    }
  }
});
run();

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n=== RESULTS ===`);
console.log(`Inserted: ${inserted}`);
console.log(`Errors: ${errors}`);
console.log(`Time: ${elapsed}s`);

// Verify
const count = db.prepare('SELECT COUNT(*) as cnt FROM dvi_shipped_jobs').get().cnt;
const hko = db.prepare('SELECT COUNT(*) as cnt FROM dvi_shipped_jobs WHERE is_hko = 1').get().cnt;
const withFrame = db.prepare('SELECT COUNT(*) as cnt FROM dvi_shipped_jobs WHERE frame_upc IS NOT NULL').get().cnt;
const withOpcL = db.prepare('SELECT COUNT(*) as cnt FROM dvi_shipped_jobs WHERE lens_opc_l IS NOT NULL').get().cnt;
console.log(`\nTotal in table: ${count}`);
console.log(`HKO jobs: ${hko}`);
console.log(`With frame UPC: ${withFrame}`);
console.log(`With left eye OPC: ${withOpcL}`);
