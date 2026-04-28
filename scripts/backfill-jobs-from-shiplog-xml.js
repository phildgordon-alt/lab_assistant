#!/usr/bin/env node
/**
 * backfill-jobs-from-shiplog-xml.js
 *
 * One-shot historical recovery for the 2026-04-28 reconcile.
 *
 * Why this exists:
 *   `upsertJobFromXML` in db.js had a field-name mismatch — it read
 *   `p.lensMaterial` and `p.lensOpcR` but parseDviXml() emits `lensMat`
 *   and `lensOpc`. Result: every SHIPLOG XML write since the unified-jobs
 *   migration silently dropped lens_material and lens_opc_r. Possibly
 *   thousands of shipped rows are missing those columns even though the
 *   XML on disk has them.
 *
 *   The fix in db.js (commit 2026-04-28) accepts both names going forward.
 *   This script repairs the historical gap by re-parsing every shipped
 *   XML on disk and UPDATEing the jobs row with COALESCE so it never
 *   overwrites a non-NULL value (defense against seeding overwrite).
 *
 *   Inbound XML (data/dvi/jobs/) is NOT a viable source — those rotate off
 *   the SMB share aggressively and most are gone. SHIPLOG XML
 *   (data/dvi/shipped/) is retained per DVI's archive policy and is the
 *   only on-disk source for historical lens classification.
 *
 * Scope:
 *   - Walks data/dvi/shipped/*.xml
 *   - For each XML: parse, then UPDATE jobs SET <fields> = COALESCE(...)
 *     keyed on invoice
 *   - Skips XMLs whose invoice doesn't exist in jobs (unjoinable)
 *   - Reports per-field fill counts at end
 *
 * Usage:
 *   node scripts/backfill-jobs-from-shiplog-xml.js           # dry run (default)
 *   node scripts/backfill-jobs-from-shiplog-xml.js --apply   # commit
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const SHIPPED_DIR = path.join(ROOT, 'data', 'dvi', 'shipped');
const REPORTS_DIR = path.join(ROOT, 'data', 'backfill-reports');

const APPLY = process.argv.includes('--apply');
const PROGRESS_EVERY = 500;

// Mirror of parseDviXml() in oven-timer-server.js — kept narrow to the
// classification slots this script writes. If parseDviXml gains new fields,
// extend this AND the UPDATE statement together.
function parseDviXmlClassification(xml) {
  const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };

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
  const getFrame = (tag) => { const m = frameXml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };

  const machineId = getAttr('MegaTransfer', 'MachineID');
  const lensOpcL = leftEyeBlock ? ((leftEyeBlock[0] || '').match(/\sOPC="([^"]*)"/) || [])[1] || null : null;
  const frameUpc = ((frameXml || '').match(/\sUPC="([^"]*)"/) || [])[1] || null;
  const frameName = ((frameXml || '').match(/\sName="([^"]*)"/) || [])[1] || null;
  const frameMat = ((frameXml || '').match(/\sMaterial="([^"]*)"/) || [])[1] || null;
  const frameColor = ((frameXml || '').match(/\sColor="([^"]*)"/) || [])[1] || null;
  const edgeType = ((frameXml || '').match(/\sEdgeType="([^"]*)"/) || [])[1] || null;

  // Rx
  const rx = { R: {}, L: {} };
  for (const [eye, block] of [['R', rightEyeBlock], ['L', leftEyeBlock]]) {
    if (!block) continue;
    const b = block[0];
    const attr = (n) => { const m = b.match(new RegExp(`\\s${n}="([^"]*)"`)); return m ? m[1] : null; };
    rx[eye] = {
      sphere: attr('Sphere'),
      cylinder: attr('Cylinder'),
      axis: attr('CylAxis') || attr('Axis'),
      pd: attr('DistancePD') || attr('PD'),
      add: attr('Add'),
    };
  }

  return {
    invoice:    getAttr('OrderData', 'Invoice'),
    reference:  getAttr('OrderData', 'Reference'),
    rxNum:      getAttr('OrderData', 'Reference') || get('RxNum'),
    entryDate:  getAttr('OrderData', 'EntryDate'),
    entryTime:  getAttr('OrderData', 'EntryTime'),
    shipDate:   getAttr('OrderData', 'ShipDate'),
    shipTime:   getAttr('OrderData', 'ShipTime'),
    daysInLab:  getAttr('RxOrder', 'DaysInLab'),
    department: getAttr('RxOrder', 'Department'),
    jobType:    getAttr('RxOrder', 'JobType'),
    operator:   getAttr('OrderData', 'Operator'),
    jobOrigin:  getAttr('OrderData', 'JobOrigin'),
    machineId,
    isHko:      machineId === '000',
    tray:       get('Tray'),
    lensType:   getEyeAttr('Type')     || getAttr('Lens', 'Type'),
    lensMat:    getEyeAttr('Material') || getLens('Mat'),
    lensStyle:  getLens('Style'),
    lensColor:  getLens('Color'),
    coating:    getLens('Coat')        || get('Coat'),
    coatType:   getAttr('Coat', 'Type'),
    lensOpc:    getEyeAttr('OPC')      || getLens('OPC'),
    lensOpcL,
    frameUpc, frameName, frameMat, frameColor,
    frameStyle: getFrame('Style'),
    frameSku:   getFrame('SKU'),
    frameMfr:   getFrame('Mfr'),
    eyeSize:    getFrame('EyeSize') || get('EyeSize'),
    bridge:     getFrame('Bridge') || get('Bridge'),
    edgeType,
    rx,
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
  return path.join(REPORTS_DIR, `shiplog-xml-backfill-${yyyy}-${mm}-${dd}.log`);
}

function main() {
  if (!fs.existsSync(DB_PATH))     { console.error('DB not found:', DB_PATH); process.exit(1); }
  if (!fs.existsSync(SHIPPED_DIR)) { console.error('Shipped dir not found:', SHIPPED_DIR); process.exit(1); }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  // UPDATE-only with COALESCE on every classification slot. Never overwrites
  // a non-NULL value — defense against seeding overwrite per Phil's
  // authoritative-seeds rule. Does NOT touch status, current_stage,
  // current_station, ship_date (the SHIPLOG-flow already owns ship_date).
  const updateStmt = db.prepare(`
    UPDATE jobs SET
      reference     = COALESCE(reference,     @reference),
      rx_number     = COALESCE(rx_number,     @rx_number),
      tray          = COALESCE(tray,          @tray),
      entry_date    = COALESCE(entry_date,    @entry_date),
      entry_time    = COALESCE(entry_time,    @entry_time),
      ship_date     = COALESCE(ship_date,     @ship_date),
      ship_time     = COALESCE(ship_time,     @ship_time),
      days_in_lab   = COALESCE(days_in_lab,   @days_in_lab),
      department    = COALESCE(department,    @department),
      job_type      = COALESCE(job_type,      @job_type),
      operator      = COALESCE(operator,      @operator),
      job_origin    = COALESCE(job_origin,    @job_origin),
      machine_id    = COALESCE(machine_id,    @machine_id),
      is_hko        = MAX(IFNULL(is_hko,0),   @is_hko),
      lens_type     = COALESCE(lens_type,     @lens_type),
      lens_material = COALESCE(lens_material, @lens_material),
      lens_style    = COALESCE(lens_style,    @lens_style),
      lens_color    = COALESCE(lens_color,    @lens_color),
      coating       = COALESCE(coating,       @coating),
      coat_type     = COALESCE(coat_type,     @coat_type),
      lens_opc_r    = COALESCE(lens_opc_r,    @lens_opc_r),
      lens_opc_l    = COALESCE(lens_opc_l,    @lens_opc_l),
      frame_upc     = COALESCE(frame_upc,     @frame_upc),
      frame_name    = COALESCE(frame_name,    @frame_name),
      frame_style   = COALESCE(frame_style,   @frame_style),
      frame_sku     = COALESCE(frame_sku,     @frame_sku),
      frame_mfr     = COALESCE(frame_mfr,     @frame_mfr),
      frame_color   = COALESCE(frame_color,   @frame_color),
      eye_size      = COALESCE(eye_size,      @eye_size),
      bridge        = COALESCE(bridge,        @bridge),
      edge_type     = COALESCE(edge_type,     @edge_type),
      rx_r_sphere   = COALESCE(rx_r_sphere,   @r_sphere),
      rx_r_cylinder = COALESCE(rx_r_cylinder, @r_cyl),
      rx_r_axis     = COALESCE(rx_r_axis,     @r_axis),
      rx_r_pd       = COALESCE(rx_r_pd,       @r_pd),
      rx_r_add      = COALESCE(rx_r_add,      @r_add),
      rx_l_sphere   = COALESCE(rx_l_sphere,   @l_sphere),
      rx_l_cylinder = COALESCE(rx_l_cylinder, @l_cyl),
      rx_l_axis     = COALESCE(rx_l_axis,     @l_axis),
      rx_l_pd       = COALESCE(rx_l_pd,       @l_pd),
      rx_l_add      = COALESCE(rx_l_add,      @l_add),
      updated_at    = datetime('now')
    WHERE invoice = @invoice
  `);

  const existsStmt = db.prepare(`SELECT 1 FROM jobs WHERE invoice = ? LIMIT 1`);

  const files = fs.readdirSync(SHIPPED_DIR).filter(f => f.endsWith('.xml'));
  console.log(`[shiplog-backfill] Found ${files.length} SHIPLOG XML files`);
  console.log(`[shiplog-backfill] Mode: ${APPLY ? 'APPLY (commit)' : 'DRY RUN — pass --apply to commit'}`);

  ensureReportsDir();
  const reportPath = reportPathForToday();
  const reportLines = [
    `# shiplog-xml-backfill — ${new Date().toISOString()}`,
    `# mode=${APPLY ? 'APPLY' : 'DRY-RUN'} files=${files.length}`,
    `# columns: filename\tinvoice\treason`,
    '',
  ];

  const stats = {
    examined: 0,
    parsed: 0,
    parseError: 0,
    noInvoice: 0,
    notInJobs: 0,
    updated: 0,
    skipped: 0,
    rowsAffected: 0,
  };

  // Pre-snapshot fill rates for the columns we touch — used to compute
  // delta after apply.
  const fillCols = [
    'lens_type','lens_material','lens_style','lens_color','coating','coat_type',
    'lens_opc_r','lens_opc_l','frame_upc','frame_name','frame_style','frame_mfr','frame_color',
    'eye_size','bridge','edge_type',
    'rx_r_sphere','rx_l_sphere',
  ];
  const beforeCounts = {};
  for (const c of fillCols) {
    beforeCounts[c] = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${c} IS NOT NULL AND ${c} != ''`).get().n;
  }

  const tx = db.transaction(() => {
    for (const file of files) {
      stats.examined++;
      if (stats.examined % PROGRESS_EVERY === 0) {
        process.stdout.write(`\r  progress: ${stats.examined}/${files.length}`);
      }

      let xml;
      try {
        xml = fs.readFileSync(path.join(SHIPPED_DIR, file), 'utf8');
      } catch (e) {
        stats.parseError++;
        reportLines.push(`${file}\t\tread-error:${e.message}`);
        continue;
      }

      let parsed;
      try {
        parsed = parseDviXmlClassification(xml);
        stats.parsed++;
      } catch (e) {
        stats.parseError++;
        reportLines.push(`${file}\t\tparse-error:${e.message}`);
        continue;
      }

      if (!parsed.invoice) {
        stats.noInvoice++;
        reportLines.push(`${file}\t\tno-invoice-attr`);
        continue;
      }

      // Skip if jobs row doesn't exist — never INSERT from SHIPLOG; only
      // enrich existing rows. Inserting from SHIPLOG would wrongly resurrect
      // canceled/purged invoices.
      const exists = existsStmt.get(parsed.invoice);
      if (!exists) {
        stats.notInJobs++;
        reportLines.push(`${file}\t${parsed.invoice}\tnot-in-jobs`);
        continue;
      }

      if (!APPLY) {
        stats.skipped++;
        continue;
      }

      try {
        const r = updateStmt.run({
          invoice:       parsed.invoice,
          reference:     parsed.reference || null,
          rx_number:     parsed.rxNum || null,
          tray:          parsed.tray || null,
          entry_date:    parsed.entryDate || null,
          entry_time:    parsed.entryTime || null,
          ship_date:     parsed.shipDate || null,
          ship_time:     parsed.shipTime || null,
          days_in_lab:   parsed.daysInLab || null,
          department:    parsed.department || null,
          job_type:      parsed.jobType || null,
          operator:      parsed.operator || null,
          job_origin:    parsed.jobOrigin || null,
          machine_id:    parsed.machineId || null,
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
          frame_sku:     parsed.frameSku || null,
          frame_mfr:     parsed.frameMfr || null,
          frame_color:   parsed.frameColor || null,
          eye_size:      parsed.eyeSize || null,
          bridge:        parsed.bridge || null,
          edge_type:     parsed.edgeType || null,
          r_sphere:      parsed.rx?.R?.sphere || null,
          r_cyl:         parsed.rx?.R?.cylinder || null,
          r_axis:        parsed.rx?.R?.axis || null,
          r_pd:          parsed.rx?.R?.pd || null,
          r_add:         parsed.rx?.R?.add || null,
          l_sphere:      parsed.rx?.L?.sphere || null,
          l_cyl:         parsed.rx?.L?.cylinder || null,
          l_axis:        parsed.rx?.L?.axis || null,
          l_pd:          parsed.rx?.L?.pd || null,
          l_add:         parsed.rx?.L?.add || null,
        });
        stats.rowsAffected += r.changes;
        stats.updated++;
      } catch (e) {
        stats.parseError++;
        reportLines.push(`${file}\t${parsed.invoice}\tupdate-error:${e.message}`);
      }
    }
  });
  tx();
  process.stdout.write('\n');

  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n');
  console.log(`[shiplog-backfill] wrote report: ${reportPath}`);
  console.log(`[shiplog-backfill] examined: ${stats.examined}`);
  console.log(`[shiplog-backfill] parsed:   ${stats.parsed}`);
  console.log(`[shiplog-backfill] parse-errors: ${stats.parseError}`);
  console.log(`[shiplog-backfill] no-invoice:   ${stats.noInvoice}`);
  console.log(`[shiplog-backfill] not-in-jobs:  ${stats.notInJobs}`);

  if (APPLY) {
    console.log(`[shiplog-backfill] updated: ${stats.updated} (rows affected: ${stats.rowsAffected})`);
    console.log(`[shiplog-backfill] per-column fill delta:`);
    for (const c of fillCols) {
      const after = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${c} IS NOT NULL AND ${c} != ''`).get().n;
      const delta = after - beforeCounts[c];
      console.log(`  ${c.padEnd(15)} ${beforeCounts[c]} → ${after} (+${delta})`);
    }
  } else {
    console.log(`[shiplog-backfill] DRY RUN — would update ${stats.skipped} rows. Re-run with --apply.`);
  }

  db.close();
}

main();
