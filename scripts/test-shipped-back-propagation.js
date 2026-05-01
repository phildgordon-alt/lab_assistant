#!/usr/bin/env node
/**
 * test-shipped-back-propagation.js — dvi_shipped_jobs → jobs back-prop (2026-04-22)
 *
 * In-memory SQLite tests for the architectural fix that prevents shipped XMLs
 * from landing in dvi_shipped_jobs without flipping the unified jobs row to
 * SHIPPED. This drift is what caused 20,345 stale SHIPPING-stage rows to
 * accumulate on prod before being cleaned up.
 *
 * Coverage:
 *   T1: upsertShippedJob back-prop flips jobs.status/current_stage to SHIPPED
 *   T2: Already-SHIPPED jobs row → back-prop is a no-op (no spurious write)
 *   T3: Self-heal SQL is idempotent — second run reports 0 changes
 *
 * NOTE: We mirror upsertShippedJob's SQL locally (same reason test-picksync.js
 * does). Importing server/db.js opens the production DB at require-time. If
 * db.js's back-prop algorithm changes, mirror it here.
 *
 * Usage: node scripts/test-shipped-back-propagation.js
 * Exits 0 on pass, 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// ── Schema mirror ────────────────────────────────────────────────────────────
// Minimum columns the back-prop touches. Keep in lockstep with db.js DDL —
// the dvi_shipped_jobs columns mirror what upsertShippedJobStmt writes; the
// jobs columns mirror what the back-prop UPDATE reads/writes.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dvi_shipped_jobs (
      invoice TEXT PRIMARY KEY,
      reference TEXT,
      ship_date TEXT,
      ship_time TEXT,
      is_hko INTEGER DEFAULT 0
    );

    CREATE TABLE jobs (
      invoice TEXT PRIMARY KEY,
      reference TEXT,
      status TEXT DEFAULT 'ACTIVE',
      current_stage TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// Mirror of db.js:upsertShippedJob (back-prop variant). Includes the
// in-transaction UPDATE to jobs that is the whole point of this fix.
function makeUpsertShippedJob(db) {
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO dvi_shipped_jobs (invoice, reference, ship_date, ship_time, is_hko)
    VALUES (?, ?, ?, ?, ?)
  `);
  const backPropStmt = db.prepare(`
    UPDATE jobs
    SET status = 'SHIPPED', current_stage = 'SHIPPED', updated_at = datetime('now')
    WHERE invoice = ?
      AND (status != 'SHIPPED' OR current_stage IS NULL OR current_stage != 'SHIPPED')
  `);
  const txn = db.transaction((p) => {
    insertStmt.run(p.invoice, p.reference || null, p.shipDate || null, p.shipTime || null, p.isHko ? 1 : 0);
    return backPropStmt.run(p.invoice);
  });
  return function upsertShippedJob(p) {
    if (!p || !p.invoice) return { changes: 0 };
    return txn(p);
  };
}

const SELF_HEAL_SQL = `
  UPDATE jobs SET status='SHIPPED', current_stage='SHIPPED', updated_at = datetime('now')
  WHERE invoice IN (SELECT invoice FROM dvi_shipped_jobs)
    AND (status != 'SHIPPED' OR current_stage IS NULL OR current_stage != 'SHIPPED')
`;

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

// ─── T1 ──────────────────────────────────────────────────────────────────────
section('T1: upsertShippedJob back-propagates to jobs');
test('jobs row at ACTIVE/SURFACING flips to SHIPPED/SHIPPED', () => {
  const db = makeDb();
  const upsertShipped = makeUpsertShippedJob(db);

  // Pre-seed jobs row in a non-shipped state (the bug scenario).
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES (?, 'ACTIVE', 'SURFACING')`).run('INV-001');

  upsertShipped({ invoice: 'INV-001', reference: 'PE-12345', shipDate: '2026-04-22', shipTime: '10:30' });

  // dvi_shipped_jobs got the XML row.
  const shippedRow = db.prepare(`SELECT * FROM dvi_shipped_jobs WHERE invoice = ?`).get('INV-001');
  assert.equal(shippedRow.invoice, 'INV-001');
  assert.equal(shippedRow.reference, 'PE-12345');

  // jobs row was back-propped to SHIPPED.
  const jobRow = db.prepare(`SELECT status, current_stage FROM jobs WHERE invoice = ?`).get('INV-001');
  assert.equal(jobRow.status, 'SHIPPED');
  assert.equal(jobRow.current_stage, 'SHIPPED');
});

test('jobs row at SHIPPING (the actual bug case) flips to SHIPPED', () => {
  const db = makeDb();
  const upsertShipped = makeUpsertShippedJob(db);
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES (?, 'ACTIVE', 'SHIPPING')`).run('INV-002');

  upsertShipped({ invoice: 'INV-002', shipDate: '2026-04-22' });

  const jobRow = db.prepare(`SELECT status, current_stage FROM jobs WHERE invoice = ?`).get('INV-002');
  assert.equal(jobRow.status, 'SHIPPED');
  assert.equal(jobRow.current_stage, 'SHIPPED');
});

test('upsert with no matching jobs row is a safe no-op (XML still lands)', () => {
  const db = makeDb();
  const upsertShipped = makeUpsertShippedJob(db);
  // No jobs row pre-seeded for this invoice.
  upsertShipped({ invoice: 'INV-NOJOB', shipDate: '2026-04-22' });
  const shippedRow = db.prepare(`SELECT * FROM dvi_shipped_jobs WHERE invoice = ?`).get('INV-NOJOB');
  assert.equal(shippedRow.invoice, 'INV-NOJOB');
  const jobRow = db.prepare(`SELECT * FROM jobs WHERE invoice = ?`).get('INV-NOJOB');
  assert.equal(jobRow, undefined, 'no jobs row created — back-prop is UPDATE-only');
});

// ─── T2 ──────────────────────────────────────────────────────────────────────
section('T2: already-SHIPPED jobs row → back-prop no-op');
test('upsert against already-SHIPPED row does not write to jobs', () => {
  const db = makeDb();
  const upsertShipped = makeUpsertShippedJob(db);

  db.prepare(`INSERT INTO jobs (invoice, status, current_stage, updated_at)
              VALUES (?, 'SHIPPED', 'SHIPPED', '2026-01-01 00:00:00')`).run('INV-003');
  const before = db.prepare(`SELECT updated_at FROM jobs WHERE invoice = ?`).get('INV-003');

  upsertShipped({ invoice: 'INV-003', shipDate: '2026-04-22' });

  const after = db.prepare(`SELECT status, current_stage, updated_at FROM jobs WHERE invoice = ?`).get('INV-003');
  assert.equal(after.status, 'SHIPPED');
  assert.equal(after.current_stage, 'SHIPPED');
  assert.equal(after.updated_at, before.updated_at,
    'WHERE clause must guard already-SHIPPED rows from spurious updated_at writes');
});

// ─── T3 ──────────────────────────────────────────────────────────────────────
section('T3: self-heal SQL idempotency');
test('seed 5 ACTIVE rows in dvi_shipped_jobs; first run flips 5, second flips 0', () => {
  const db = makeDb();

  // Pre-seed 5 jobs that are already in dvi_shipped_jobs but stuck at ACTIVE/SHIPPING.
  for (let i = 1; i <= 5; i++) {
    const inv = `STUCK-${i.toString().padStart(3, '0')}`;
    db.prepare(`INSERT INTO dvi_shipped_jobs (invoice, ship_date) VALUES (?, '2026-04-22')`).run(inv);
    db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES (?, 'ACTIVE', 'SHIPPING')`).run(inv);
  }
  // And one control row that is NOT in dvi_shipped_jobs — must not be touched.
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES (?, 'ACTIVE', 'SURFACING')`).run('CTRL-001');

  const r1 = db.prepare(SELF_HEAL_SQL).run();
  assert.equal(r1.changes, 5, 'first run flips all 5 stuck rows');

  // Verify all 5 are SHIPPED/SHIPPED.
  const flipped = db.prepare(`SELECT COUNT(*) AS cnt FROM jobs WHERE status='SHIPPED' AND current_stage='SHIPPED'`).get();
  assert.equal(flipped.cnt, 5);

  // Control row untouched.
  const ctrl = db.prepare(`SELECT status, current_stage FROM jobs WHERE invoice = 'CTRL-001'`).get();
  assert.equal(ctrl.status, 'ACTIVE');
  assert.equal(ctrl.current_stage, 'SURFACING');

  // Idempotency: second run is a no-op.
  const r2 = db.prepare(SELF_HEAL_SQL).run();
  assert.equal(r2.changes, 0, 'second run must be a no-op');
});

test('partially-shipped (status=SHIPPED but current_stage stale) gets stage flipped', () => {
  // Edge case: upsertJobFromXML in db.js sets status='SHIPPED' but never
  // touched current_stage. Self-heal must still catch these.
  const db = makeDb();
  db.prepare(`INSERT INTO dvi_shipped_jobs (invoice, ship_date) VALUES (?, '2026-04-22')`).run('PARTIAL-001');
  db.prepare(`INSERT INTO jobs (invoice, status, current_stage) VALUES (?, 'SHIPPED', 'SHIPPING')`).run('PARTIAL-001');

  const r = db.prepare(SELF_HEAL_SQL).run();
  assert.equal(r.changes, 1);
  const after = db.prepare(`SELECT status, current_stage FROM jobs WHERE invoice = 'PARTIAL-001'`).get();
  assert.equal(after.current_stage, 'SHIPPED');
});

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  for (const step of pendingTests) await step();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
