#!/usr/bin/env node
/**
 * test-inbound-xml-classification.js — covers upsertJobClassificationFromXML.
 *
 * In-memory SQLite tests modeled on test-picksync.js. Reproduces the UPSERT
 * body locally because requiring server/db.js opens the production DB on
 * require. If the algorithm changes there, mirror the change here.
 *
 * Coverage:
 *   T1: existing row with status=ACTIVE, NULL lens_type → fields populated,
 *       status STILL ACTIVE, current_stage UNCHANGED.
 *   T2: existing row with lens_type='S' → COALESCE preserves 'S' over 'C'.
 *   T3: no row exists → INSERT with status='ACTIVE', current_stage='INCOMING',
 *       lens_type populated.
 *   T4: existing row with current_stage='COATING' and status='ACTIVE' → only
 *       classification fields updated; current_stage stays 'COATING'.
 *
 * Usage: node scripts/test-inbound-xml-classification.js
 * Exits 0 on pass, 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// Schema mirror — minimal columns needed for these tests, must match db.js.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs (
      invoice TEXT PRIMARY KEY,
      reference TEXT,
      rx_number TEXT,
      entry_date TEXT,
      entry_time TEXT,
      department TEXT,
      job_type TEXT,
      is_hko INTEGER DEFAULT 0,
      lens_type TEXT,
      lens_material TEXT,
      lens_style TEXT,
      lens_color TEXT,
      coating TEXT,
      coat_type TEXT,
      lens_opc_r TEXT,
      lens_opc_l TEXT,
      frame_upc TEXT,
      frame_name TEXT,
      frame_style TEXT,
      status TEXT DEFAULT 'ACTIVE',
      current_stage TEXT,
      current_station TEXT,
      first_seen_at TEXT,
      last_event_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// Mirror of upsertJobClassificationFromXML in db.js. Keep in lockstep.
function makeUpsert(db) {
  const stmt = db.prepare(`
    INSERT INTO jobs (invoice, reference, rx_number, entry_date, entry_time,
                      department, job_type, is_hko,
                      lens_type, lens_material, lens_style, lens_color,
                      coating, coat_type, lens_opc_r, lens_opc_l,
                      frame_upc, frame_name, frame_style,
                      status, current_stage, updated_at)
    VALUES (?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
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
  return function upsertJobClassificationFromXML(p) {
    if (!p || !p.invoice) return;
    const lensMaterial = p.lensMaterial != null ? p.lensMaterial : p.lensMat;
    const lensOpcR     = p.lensOpcR     != null ? p.lensOpcR     : p.lensOpc;
    stmt.run(
      p.invoice,
      p.reference || null,
      p.rxNum || p.rxNumber || null,
      p.entryDate || null,
      p.entryTime || null,
      p.department || null,
      p.jobType || null,
      p.isHko ? 1 : 0,
      p.lensType || null,
      lensMaterial || null,
      p.lensStyle || null,
      p.lensColor || null,
      p.coating || null,
      p.coatType || null,
      lensOpcR || null,
      p.lensOpcL || null,
      p.frameUpc || null,
      p.frameName || null,
      p.frameStyle || null
    );
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const pendingTests = [];
function test(name, fn) {
  pendingTests.push(async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
  });
}
function section(name) { pendingTests.push(async () => console.log(`\n${name}`)); }

// ─── T1: enrich a NULL-lens_type ACTIVE row ─────────────────────────────────
section('T1: trace-born ACTIVE row gets classification fields');
test('NULL lens_type → populated; status & current_stage unchanged', () => {
  const db = makeDb();
  const upsert = makeUpsert(db);

  // Trace path created the row earlier — current_stage='SURFACING', no class.
  db.prepare(`
    INSERT INTO jobs (invoice, status, current_stage, current_station,
                      first_seen_at, last_event_at)
    VALUES (?, 'ACTIVE', 'SURFACING', 'GEN-01',
            '2026-04-22T09:00:00Z', '2026-04-22T09:30:00Z')
  `).run('INV-1');

  upsert({
    invoice: 'INV-1',
    lensType: 'P', lensMat: 'POLY', lensStyle: 'PROG-X', lensColor: 'CLR',
    coating: 'AR', coatType: 'Lab', lensOpc: '7100012345', lensOpcL: '7100012346',
    frameUpc: '0123456789', frameName: 'TopFrame', frameStyle: 'STY-1',
    reference: 'ORD-1', rxNum: 'RX-1', entryDate: '04/20/26', entryTime: '10:15',
    department: '1', jobType: 'NEW', isHko: false,
  });

  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = 'INV-1'`).get();
  assert.equal(row.lens_type, 'P');
  assert.equal(row.lens_material, 'POLY');
  assert.equal(row.lens_style, 'PROG-X');
  assert.equal(row.coating, 'AR');
  assert.equal(row.lens_opc_r, '7100012345');
  assert.equal(row.lens_opc_l, '7100012346');
  assert.equal(row.frame_upc, '0123456789');
  assert.equal(row.frame_name, 'TopFrame');
  // Unchanged: status, current_stage, current_station, first_seen_at, last_event_at.
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.current_stage, 'SURFACING');
  assert.equal(row.current_station, 'GEN-01');
  assert.equal(row.first_seen_at, '2026-04-22T09:00:00Z');
  assert.equal(row.last_event_at, '2026-04-22T09:30:00Z');
});

// ─── T2: COALESCE preserves an existing populated lens_type ─────────────────
section('T2: existing populated lens_type is preserved');
test("lens_type='S' stays 'S' even if XML says 'C'", () => {
  const db = makeDb();
  const upsert = makeUpsert(db);

  db.prepare(`
    INSERT INTO jobs (invoice, status, current_stage, lens_type, lens_material)
    VALUES ('INV-2', 'ACTIVE', 'COATING', 'S', 'POLY')
  `).run();

  upsert({
    invoice: 'INV-2',
    lensType: 'C',          // would change S → C without COALESCE
    lensMat:  'TRIVEX',     // would change POLY → TRIVEX without COALESCE
    coating:  'BLUE_CUT',   // null → BLUE_CUT (legitimate fill)
  });

  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = 'INV-2'`).get();
  assert.equal(row.lens_type, 'S', 'first-write wins on lens_type');
  assert.equal(row.lens_material, 'POLY', 'first-write wins on lens_material');
  assert.equal(row.coating, 'BLUE_CUT', 'NULL → value fills correctly');
  assert.equal(row.current_stage, 'COATING', 'current_stage untouched');
});

// ─── T3: no existing row → INSERT with sane defaults ────────────────────────
section('T3: no row exists → INSERT seeds status=ACTIVE, current_stage=INCOMING');
test('XML lands before any trace event', () => {
  const db = makeDb();
  const upsert = makeUpsert(db);

  upsert({
    invoice: 'INV-3',
    lensType: 'B', lensMat: 'HIINDEX', coating: 'AR',
    reference: 'ORD-3',
  });

  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = 'INV-3'`).get();
  assert.ok(row, 'row was inserted');
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.current_stage, 'INCOMING');
  assert.equal(row.lens_type, 'B');
  assert.equal(row.lens_material, 'HIINDEX');
  assert.equal(row.coating, 'AR');
  assert.equal(row.reference, 'ORD-3');
  // No trace fields — first_seen_at / last_event_at remain NULL.
  assert.equal(row.first_seen_at, null);
  assert.equal(row.last_event_at, null);
  assert.equal(row.current_station, null);
});

// ─── T4: COATING row keeps its stage ────────────────────────────────────────
section('T4: existing current_stage=COATING is not regressed to INCOMING');
test('classification UPDATE never moves stage backwards', () => {
  const db = makeDb();
  const upsert = makeUpsert(db);

  db.prepare(`
    INSERT INTO jobs (invoice, status, current_stage, current_station,
                      first_seen_at, last_event_at)
    VALUES ('INV-4', 'ACTIVE', 'COATING', 'EB9001',
            '2026-04-22T08:00:00Z', '2026-04-22T11:45:00Z')
  `).run();

  upsert({
    invoice: 'INV-4',
    lensType: 'P',
    coating:  'AR',
  });

  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = 'INV-4'`).get();
  assert.equal(row.current_stage, 'COATING', 'COATING preserved');
  assert.equal(row.current_station, 'EB9001', 'current_station preserved');
  assert.equal(row.status, 'ACTIVE', 'status preserved');
  assert.equal(row.lens_type, 'P', 'lens_type filled');
  assert.equal(row.coating, 'AR', 'coating filled');
  assert.equal(row.first_seen_at, '2026-04-22T08:00:00Z');
  assert.equal(row.last_event_at, '2026-04-22T11:45:00Z');
});

// ─── T5: SHIPPED row guard (bonus) ──────────────────────────────────────────
// The hard rule says "do not let it transition status backward (SHIPPED →
// ACTIVE)". Our ON CONFLICT branch never writes status, so a SHIPPED row stays
// SHIPPED — verify explicitly.
section('T5: SHIPPED row is never reverted to ACTIVE');
test('upsert against an existing SHIPPED row leaves status=SHIPPED', () => {
  const db = makeDb();
  const upsert = makeUpsert(db);

  db.prepare(`
    INSERT INTO jobs (invoice, status, current_stage, lens_type)
    VALUES ('INV-5', 'SHIPPED', 'SHIPPED', NULL)
  `).run();

  upsert({ invoice: 'INV-5', lensType: 'P', coating: 'AR' });

  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = 'INV-5'`).get();
  assert.equal(row.status, 'SHIPPED', 'SHIPPED stays SHIPPED');
  assert.equal(row.current_stage, 'SHIPPED', 'stage unchanged');
  assert.equal(row.lens_type, 'P', 'classification still fills NULL slots');
});

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  for (const step of pendingTests) await step();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
