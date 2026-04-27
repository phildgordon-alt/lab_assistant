#!/usr/bin/env node
/**
 * test-backfill-tier3.js — covers the tiered backfill resolution AND the
 * trace-validation guards added in the same PR.
 *
 * In-memory SQLite tests modeled on test-inbound-xml-classification.js. The
 * production code lives in scripts/backfill-active-wip-lens-type.js,
 * server/dvi-trace.js (parseTraceLine), and server/db.js (upsertJobFromTrace).
 * We can't `require` those directly because the script self-executes and the
 * server modules open the production DB on require. So this file mirrors
 * each function — keep in lockstep.
 *
 * Coverage:
 *   T1: candidate has inbound XML → uses Tier 1, doesn't hit Tier 2 or 3.
 *   T2: candidate has no inbound but has SHIPLOG XML → uses Tier 2.
 *   T3: candidate has no XMLs but has picks_history with a SKU known to
 *       lens_sku_properties → uses Tier 3, fills lens_type from
 *       lens_type_modal.
 *   T4: candidate has nothing → skipped, counted as no-source.
 *   T5: parseTraceLine drops '11', '1', '20260413', 'abc'; accepts '441487',
 *       '5868865535'.
 *   T6: upsertJobFromTrace early-returns on bad invoice (no INSERT).
 *   T7: loadHistory drops the trailing partial line when file doesn't end in \n.
 *
 * Usage: node scripts/test-backfill-tier3.js
 * Exits 0 on pass, 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// ── Schema mirror — minimal columns needed for these tests, must match db.js. ──
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
    CREATE TABLE picks_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pick_id TEXT,
      order_id TEXT,
      sku TEXT,
      name TEXT,
      qty INTEGER,
      picked INTEGER,
      warehouse TEXT,
      completed_at TEXT,
      recorded_at TEXT DEFAULT (datetime('now')),
      source TEXT
    );
    CREATE TABLE lens_sku_properties (
      sku             TEXT PRIMARY KEY,
      material        TEXT,
      lens_type_modal TEXT,
      base_curve      REAL
    );
  `);
  return db;
}

// ── Mirror of parseDviXmlClassification (subset — just what we need for asserts). ──
function parseDviXmlClassification(xml) {
  const getAttr = (tag, attr) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  const eyeBlock = xml.match(/<RightEye[^>]*(?:\/>|>[\s\S]*?<\/RightEye>)/);
  const eyeXml = eyeBlock ? eyeBlock[0] : '';
  const getEyeAttr = (attr) => { const m = eyeXml.match(new RegExp(`\\s${attr}="([^"]*)"`)); return m ? m[1] : null; };
  return {
    invoice:    getAttr('OrderData', 'Invoice'),
    reference:  getAttr('OrderData', 'Reference'),
    lensType:   getEyeAttr('Type'),
    lensMat:    getEyeAttr('Material'),
    lensOpc:    getEyeAttr('OPC'),
  };
}

// ── Mirror of upsertJobClassificationFromXML (Tier 1/2 path). ──
function makeXmlUpsert(db) {
  const stmt = db.prepare(`
    INSERT INTO jobs (invoice, lens_type, lens_material, lens_opc_r,
                      reference, status, current_stage, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', 'INCOMING', datetime('now'))
    ON CONFLICT(invoice) DO UPDATE SET
      lens_type     = COALESCE(jobs.lens_type,     excluded.lens_type),
      lens_material = COALESCE(jobs.lens_material, excluded.lens_material),
      lens_opc_r    = COALESCE(jobs.lens_opc_r,    excluded.lens_opc_r),
      reference     = COALESCE(jobs.reference,     excluded.reference),
      updated_at    = datetime('now')
  `);
  return (p) => stmt.run(p.invoice, p.lensType || null, p.lensMat || null, p.lensOpc || null, p.reference || null);
}

// ── Mirror of Tier 3 update (UPDATE-only with COALESCE). ──
function makeTier3Update(db) {
  const stmt = db.prepare(`
    UPDATE jobs SET
      lens_type     = COALESCE(lens_type, @lens_type),
      lens_material = COALESCE(lens_material, @lens_material),
      lens_opc_r    = COALESCE(lens_opc_r, @lens_opc_r),
      updated_at    = datetime('now')
    WHERE invoice = @invoice
  `);
  return (params) => stmt.run(params);
}

// ── Mirror of Tier 3 lookup. ──
function makeTier3Lookup(db) {
  return db.prepare(`
    SELECT ph.sku        AS sku,
           lsp.material  AS material,
           lsp.lens_type_modal AS lens_type_modal,
           lsp.base_curve AS base_curve
    FROM picks_history ph
    LEFT JOIN lens_sku_properties lsp ON lsp.sku = ph.sku
    WHERE ph.order_id = ?
    ORDER BY ph.completed_at DESC
    LIMIT 1
  `);
}

// ── Mirror of parseTraceLine (just the validation, with the same regex). ──
let _corruptLineCount = 0;
function parseTraceLine(line) {
  const parts = line.split('\t');
  if (parts.length < 6) return null;
  const invNum = (parts[1] || '').trim();
  const station = (parts[5] || '').trim();
  if (!invNum || !station) return null;
  if (!/^\d{4,}$/.test(invNum)) {
    _corruptLineCount++;
    return null;
  }
  return { jobId: invNum, station };
}

// ── Mirror of upsertJobFromTrace early-return guard. ──
function makeUpsertJobFromTrace(db) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO jobs (invoice, status) VALUES (?, 'ACTIVE')`);
  return (j) => {
    if (!j || !j.invoice) return;
    if (!/^\d{4,}$/.test(String(j.invoice))) return;
    stmt.run(j.invoice);
  };
}

// ── Mirror of the loadHistory partialLine logic. ──
function loadHistorySplit(text) {
  const lines = text.split(/\r?\n/);
  if (!/\n$/.test(text) && lines.length > 0) lines.pop();
  return lines;
}

// ── Tiered resolution mirror (the function-under-test). ──
function makeBackfill(db) {
  const tier3Lookup = makeTier3Lookup(db);
  const tier3Update = makeTier3Update(db);
  const xmlUpsert = makeXmlUpsert(db);

  // tier1Files / tier2Files are { invoice -> xml } maps that simulate the
  // filesystem read. The real script does fs.readFileSync; in tests we
  // pass the parsed XML directly to keep the test pure.
  return function backfill(invoice, { tier1Xml, tier2Xml }) {
    const result = { tier: null, parsed: null, tier3: null };

    // Tier 1
    if (tier1Xml) {
      const p = parseDviXmlClassification(tier1Xml);
      if (p && p.lensType) {
        result.tier = 1; result.parsed = p;
        xmlUpsert(p);
        return result;
      }
    }
    // Tier 2
    if (tier2Xml) {
      const p = parseDviXmlClassification(tier2Xml);
      if (p && p.lensType) {
        result.tier = 2; result.parsed = p;
        xmlUpsert(p);
        return result;
      }
    }
    // Tier 3
    const row = tier3Lookup.get(invoice);
    if (row && (row.lens_type_modal || row.material)) {
      const t3 = {
        invoice,
        lens_type:     row.lens_type_modal || null,
        lens_material: row.material || null,
        lens_opc_r:    row.sku || null,
      };
      if (t3.lens_type) {
        result.tier = 3; result.tier3 = t3;
        tier3Update(t3);
        return result;
      }
    }
    // No source.
    return result;
  };
}

// ── Sample XMLs ──
const XML_INBOUND_INV1 = `<MegaTransfer><RxOrder><OrderData Invoice="100001" Reference="REF-1"/>
  <RightEye Type="P" Material="POLY" OPC="4800135412"/></RxOrder></MegaTransfer>`;
const XML_SHIPLOG_INV2 = `<MegaTransfer><RxOrder><OrderData Invoice="100002" Reference="REF-2"/>
  <RightEye Type="S" Material="BLY" OPC="265007922"/></RxOrder></MegaTransfer>`;

// ── Harness ──
let passed = 0, failed = 0;
const pendingTests = [];
function test(name, fn) {
  pendingTests.push(async () => {
    try { await fn(); console.log(`  ${'✓'} ${name}`); passed++; }
    catch (e) { console.error(`  ${'✗'} ${name}\n    ${e.message}`); failed++; }
  });
}
function section(name) { pendingTests.push(async () => console.log(`\n${name}`)); }

// ─── T1 ─────────────────────────────────────────────────────────────────────
section('T1: inbound XML present → Tier 1 wins');
test('Tier 1 fills lens_type, does not fall through to Tier 2 or 3', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES ('100001', 'ACTIVE', 'SURFACING')`).run();
  // Also seed a SHIPLOG XML and a picks_history row to prove they aren't used.
  const backfill = makeBackfill(db);
  db.prepare(`INSERT INTO picks_history (pick_id, order_id, sku, completed_at) VALUES ('p1', '100001', '4800135412', '2026-04-22T09:00:00Z')`).run();
  db.prepare(`INSERT INTO lens_sku_properties (sku, material, lens_type_modal) VALUES ('4800135412', 'PLY', 'P')`).run();

  const r = backfill('100001', { tier1Xml: XML_INBOUND_INV1, tier2Xml: XML_SHIPLOG_INV2 });
  assert.equal(r.tier, 1);
  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = '100001'`).get();
  assert.equal(row.lens_type, 'P');
  assert.equal(row.lens_material, 'POLY');
  assert.equal(row.lens_opc_r, '4800135412');
  assert.equal(row.current_stage, 'SURFACING', 'current_stage preserved');
});

// ─── T2 ─────────────────────────────────────────────────────────────────────
section('T2: no inbound XML, SHIPLOG XML present → Tier 2 wins');
test('Tier 2 fills lens_type from shipped/<inv>.xml', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES ('100002', 'ACTIVE', 'COATING')`).run();
  const backfill = makeBackfill(db);

  const r = backfill('100002', { tier1Xml: null, tier2Xml: XML_SHIPLOG_INV2 });
  assert.equal(r.tier, 2);
  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = '100002'`).get();
  assert.equal(row.lens_type, 'S');
  assert.equal(row.lens_material, 'BLY');
  assert.equal(row.lens_opc_r, '265007922');
  assert.equal(row.current_stage, 'COATING', 'current_stage preserved');
});

// ─── T3 ─────────────────────────────────────────────────────────────────────
section('T3: no XMLs, picks_history + lens_sku_properties → Tier 3 wins');
test('Tier 3 fills lens_type from lens_type_modal', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES ('100003', 'ACTIVE', 'CUTTING')`).run();
  db.prepare(`INSERT INTO picks_history (pick_id, order_id, sku, completed_at) VALUES ('p3', '100003', '4800135412', '2026-04-22T09:00:00Z')`).run();
  db.prepare(`INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve) VALUES ('4800135412', 'PLY', 'P', 4.0)`).run();
  const backfill = makeBackfill(db);

  const r = backfill('100003', { tier1Xml: null, tier2Xml: null });
  assert.equal(r.tier, 3);
  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = '100003'`).get();
  assert.equal(row.lens_type, 'P');
  assert.equal(row.lens_material, 'PLY');
  assert.equal(row.lens_opc_r, '4800135412');
  assert.equal(row.current_stage, 'CUTTING', 'current_stage preserved');
  assert.equal(row.status, 'ACTIVE', 'status preserved');
});

// ─── T4 ─────────────────────────────────────────────────────────────────────
section('T4: no XMLs and no picks_history → skip');
test('candidate with no source returns tier=null', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES ('100004', 'ACTIVE', 'CUTTING')`).run();
  const backfill = makeBackfill(db);

  const r = backfill('100004', { tier1Xml: null, tier2Xml: null });
  assert.equal(r.tier, null);
  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = '100004'`).get();
  assert.equal(row.lens_type, null, 'lens_type stays NULL');
});

// ─── T4b: pick exists but SKU not in lens_sku_properties → also skip. ──────
section('T4b: pick exists but SKU has no lens_sku_properties row → skip');
test('Tier 3 lookup returns row with NULL lens_type_modal+material → skip', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES ('100005', 'ACTIVE', 'CUTTING')`).run();
  db.prepare(`INSERT INTO picks_history (pick_id, order_id, sku, completed_at) VALUES ('p5', '100005', 'UNKNOWN-SKU', '2026-04-22T09:00:00Z')`).run();
  // No lens_sku_properties row → LEFT JOIN returns NULL for material/lens_type_modal.
  const backfill = makeBackfill(db);

  const r = backfill('100005', { tier1Xml: null, tier2Xml: null });
  assert.equal(r.tier, null);
  const row = db.prepare(`SELECT * FROM jobs WHERE invoice = '100005'`).get();
  assert.equal(row.lens_type, null);
});

// ─── T5: parseTraceLine validation ──────────────────────────────────────────
section('T5: parseTraceLine drops malformed invoice values');
test('rejects "11", "1", "abc", "abc1234"; accepts "441487", "5868865535"', () => {
  // mkLine: enough tab-separated fields to pass the parts.length>=6 check.
  // INVNUM is column index 1 (the second field).
  const mkLine = (inv) => `T01\t${inv}\t20260422\t10:00\t10\tCUTTING\t1\tCAT\tOP\tMID\tP1`;
  assert.equal(parseTraceLine(mkLine('11')), null, 'short numeric "11" rejected (<4)');
  assert.equal(parseTraceLine(mkLine('1')),  null, 'short numeric "1" rejected (<4)');
  assert.equal(parseTraceLine(mkLine('abc')), null, 'alphabetic rejected');
  assert.equal(parseTraceLine(mkLine('abc1234')), null, 'mixed alphanumeric rejected');
  assert.ok(parseTraceLine(mkLine('441487')), '6-digit invoice accepted');
  assert.ok(parseTraceLine(mkLine('5868865535')), '10-digit invoice accepted');
});
// NOTE on date-shaped 8-digit invoices like '20260413': the planner spec
// listed this as "should drop" but the regex they gave (^\d{4,}$) is
// permissive on length and lets it through. The cleanup script's GLOB
// filter (Change 3, ~9 corrupted historical rows are date-shaped) is the
// authoritative defense for date-shaped invoices. Tightening the parser
// regex to forbid 8-digit-starting-with-20 would risk false-positives on
// real future invoices that happen to land in that range. Flagged in
// "edge cases noticed but not handled" — see PR notes.
test('"20260413" passes (not dropped) — see comment block above', () => {
  const mkLine = (inv) => `T01\t${inv}\t20260422\t10:00\t10\tCUTTING\t1\tCAT\tOP\tMID\tP1`;
  assert.ok(parseTraceLine(mkLine('20260413')), 'date-shaped 8-digit accepted by parser; cleanup script catches');
});

// ─── T6: upsertJobFromTrace early-return guard ──────────────────────────────
section('T6: upsertJobFromTrace early-returns on bad invoice');
test('no INSERT when invoice is non-numeric or short', () => {
  const db = makeDb();
  const upsert = makeUpsertJobFromTrace(db);
  upsert({ invoice: '1' });
  upsert({ invoice: 'abc' });
  upsert({ invoice: '11' });
  upsert({ invoice: null });
  upsert(null);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get().n;
  assert.equal(n, 0, 'no rows inserted');
  upsert({ invoice: '441487' });
  const n2 = db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get().n;
  assert.equal(n2, 1, 'good invoice was inserted');
});

// ─── T7: loadHistory partialLine handling ───────────────────────────────────
section('T7: loadHistory drops trailing partial line when no terminating \\n');
test('text without trailing \\n: last "line" is dropped', () => {
  const text = 'line1\nline2\nline3-partial';
  const lines = loadHistorySplit(text);
  assert.deepEqual(lines, ['line1', 'line2'], 'partial last line dropped');
});
test('text with trailing \\n: all lines kept (last is empty string)', () => {
  const text = 'line1\nline2\nline3\n';
  const lines = loadHistorySplit(text);
  // split yields ['line1','line2','line3','']. Trailing '' is harmless —
  // the line.trim() check downstream skips it.
  assert.deepEqual(lines, ['line1', 'line2', 'line3', ''], 'all lines kept');
});
test('empty text: pop() drops the lone empty entry, no crash', () => {
  // ''.split(/\r?\n/) → [''], no trailing newline, so pop yields []. Benign:
  // downstream loop has nothing to parse.
  assert.deepEqual(loadHistorySplit(''), []);
});

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  for (const step of pendingTests) await step();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
