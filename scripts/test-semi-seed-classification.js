#!/usr/bin/env node
/**
 * test-semi-seed-classification.js — semi-finished SKU seed classification
 *
 * Regression test for the bug where the seed UPSERT in server/db.js used
 * COALESCE(existing, seed) for lens_type_modal, allowing a backfill-written
 * 'S' classification on a true puck SKU to override the seed's 'P'.
 *
 * Coverage:
 *   T1: Empty lens_sku_properties + seed → all SEED rows land with 'P'
 *   T2: Pre-existing row with lens_type_modal='S' → forced to 'P' (NOT preserved)
 *   T3: Pre-existing custom material='OVERRIDE' → preserved (COALESCE wins for material)
 *   T4: Pre-existing custom base_curve=99.0 + seed has BC for that SKU → seed wins
 *       (base_curve uses COALESCE(excluded, existing) — seed-first)
 *
 * NOTE: We don't import server/db.js (it opens the production DB on require).
 * The schema + seed UPSERT are mirrored locally — keep this in lockstep with
 * db.js if either changes. Same pattern as test-picksync.js.
 *
 * Usage: node scripts/test-semi-seed-classification.js
 * Exits 0 on pass, 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const { SEMI_FINISHED_SEED } = require(path.join(__dirname, '..', 'server', 'lib', 'semifinished-seed'));

// ── Schema mirror of db.js lens_sku_properties ───────────────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE lens_sku_properties (
      sku                 TEXT PRIMARY KEY,
      material            TEXT,
      lens_type_modal     TEXT,
      base_curve          REAL,
      sample_job_count    INTEGER DEFAULT 0,
      first_seen          TEXT,
      last_seen           TEXT,
      last_aggregated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// Mirror of the seed UPSERT in db.js:235-251 (post-fix).
// lens_type_modal must be seed-authoritative; material + base_curve fall back.
function makeSeedUpsert(db) {
  const stmt = db.prepare(`
    INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve, sample_job_count, last_aggregated_at)
    VALUES (?, ?, 'P', ?, 0, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      material        = COALESCE(lens_sku_properties.material, excluded.material),
      lens_type_modal = excluded.lens_type_modal,
      base_curve      = COALESCE(excluded.base_curve, lens_sku_properties.base_curve)
  `);
  return function runSeed() {
    const tx = db.transaction(() => {
      for (const s of SEMI_FINISHED_SEED) stmt.run(s.sku, s.material, s.base_curve);
    });
    tx();
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const pendingTests = [];
function test(name, fn) {
  pendingTests.push(() => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
  });
}
function section(name) { pendingTests.push(() => console.log(`\n${name}`)); }

// ─── T1: empty table → all seed SKUs land with lens_type_modal='P' ───────────
section("T1: empty table — all seed SKUs land with lens_type_modal='P'");
test('every SEMI_FINISHED_SEED sku is inserted with P', () => {
  const db = makeDb();
  const runSeed = makeSeedUpsert(db);
  runSeed();

  const rows = db.prepare(`SELECT sku, material, lens_type_modal, base_curve FROM lens_sku_properties`).all();
  assert.equal(rows.length, SEMI_FINISHED_SEED.length, 'row count matches seed');
  const nonP = rows.filter(r => r.lens_type_modal !== 'P');
  assert.equal(nonP.length, 0, `all rows must be P; offenders: ${JSON.stringify(nonP)}`);

  // Spot-check the 5 SKUs from the bug report.
  const targets = ['4800135339', '4800135412', '4800135420', '4800150924', '4800150940'];
  for (const sku of targets) {
    const row = rows.find(r => r.sku === sku);
    assert.ok(row, `seed SKU ${sku} present`);
    assert.equal(row.lens_type_modal, 'P', `${sku} must be P`);
  }
});

// ─── T2: pre-existing 'S' → forced to 'P' (NOT preserved) ────────────────────
section("T2: pre-existing lens_type_modal='S' is overridden by seed's 'P'");
test('backfill-written S on a seed SKU is forced back to P', () => {
  const db = makeDb();
  const seedSku = '4800135339'; // BLY puck from the bug list
  // Simulate the backfill having written 'S' first.
  db.prepare(`
    INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve, sample_job_count)
    VALUES (?, 'BLY', 'S', 0.25, 42)
  `).run(seedSku);

  const before = db.prepare(`SELECT lens_type_modal FROM lens_sku_properties WHERE sku = ?`).get(seedSku);
  assert.equal(before.lens_type_modal, 'S', 'pre-condition: row starts as S');

  const runSeed = makeSeedUpsert(db);
  runSeed();

  const after = db.prepare(`SELECT lens_type_modal, sample_job_count FROM lens_sku_properties WHERE sku = ?`).get(seedSku);
  assert.equal(after.lens_type_modal, 'P', 'seed must force lens_type_modal back to P');
  // sample_job_count is NOT touched by the UPSERT — backfill-derived stats survive.
  assert.equal(after.sample_job_count, 42, 'sample_job_count from backfill is preserved');
});

// ─── T3: pre-existing custom material → preserved (COALESCE) ─────────────────
section("T3: pre-existing custom material is preserved (COALESCE only on material)");
test("custom material='OVERRIDE' stays, but lens_type_modal still gets forced to 'P'", () => {
  const db = makeDb();
  const seedSku = '4800135412'; // PLY puck from the bug list
  db.prepare(`
    INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve, sample_job_count)
    VALUES (?, 'OVERRIDE', 'S', 0.5, 0)
  `).run(seedSku);

  const runSeed = makeSeedUpsert(db);
  runSeed();

  const after = db.prepare(`SELECT material, lens_type_modal FROM lens_sku_properties WHERE sku = ?`).get(seedSku);
  assert.equal(after.material, 'OVERRIDE', 'material preserved by COALESCE(existing, excluded)');
  assert.equal(after.lens_type_modal, 'P', 'lens_type_modal still forced to P');
});

// ─── T4: pre-existing custom base_curve + seed has BC → seed wins ────────────
section("T4: base_curve uses COALESCE(excluded, existing) — seed wins when seed has a BC");
test('pre-existing base_curve=99.0 is overwritten by seed value when seed has one', () => {
  const db = makeDb();
  const seedSku = '4800135412'; // seed BC = 0.5
  const seedRow = SEMI_FINISHED_SEED.find(s => s.sku === seedSku);
  assert.ok(seedRow && seedRow.base_curve !== null, 'fixture: seed row has a BC');

  db.prepare(`
    INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve, sample_job_count)
    VALUES (?, 'PLY', 'S', 99.0, 0)
  `).run(seedSku);

  const runSeed = makeSeedUpsert(db);
  runSeed();

  const after = db.prepare(`SELECT base_curve FROM lens_sku_properties WHERE sku = ?`).get(seedSku);
  // COALESCE(excluded.base_curve, lens_sku_properties.base_curve) → seed wins
  // when seed is non-null. This is the documented behavior; if you change it,
  // update the seed comment in db.js too.
  assert.equal(after.base_curve, seedRow.base_curve,
    `seed BC (${seedRow.base_curve}) wins over existing 99.0; got ${after.base_curve}`);

  // Companion case: when the seed has a NULL base_curve, the existing value
  // must be preserved (e.g. Phil filled in a BC for a photochromic SKU in the UI).
  // Use a fresh DB so we control the pre-existing state cleanly.
  const db2 = makeDb();
  const runSeed2 = makeSeedUpsert(db2);
  const nullBcSeed = SEMI_FINISHED_SEED.find(s => s.base_curve === null);
  assert.ok(nullBcSeed, 'fixture: at least one seed row has null BC');
  db2.prepare(`
    INSERT INTO lens_sku_properties (sku, material, lens_type_modal, base_curve, sample_job_count)
    VALUES (?, ?, 'P', 7.5, 0)
  `).run(nullBcSeed.sku, nullBcSeed.material);
  runSeed2();
  const nullBcAfter = db2.prepare(`SELECT base_curve FROM lens_sku_properties WHERE sku = ?`).get(nullBcSeed.sku);
  assert.equal(nullBcAfter.base_curve, 7.5,
    'pre-existing BC preserved when seed BC is null');
});

// ═════════════════════════════════════════════════════════════════════════════
for (const step of pendingTests) step();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
