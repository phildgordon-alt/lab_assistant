#!/usr/bin/env node
/**
 * test-picksync.js — pickSync rebuild (2026-04-22) + delta-poll (2026-04-23)
 *
 * In-memory SQLite tests for the picks_history rebuild. Modeled on test-npi.js.
 * Coverage:
 *   T1: upsertPicksHistory writes source='live'
 *   T2: upsertPicksHistory writes source='tx'
 *   T3: INSERT OR IGNORE — first writer wins, source preserved
 *   T4: tx-writer dedupes against live-writer rows on shared pick_id
 *   T5: BACKFILL loop guard — < 50 inserted on day with count > 0 marks attempted
 *   T6: local recovery — picks→picks_history insert with source='recovered'
 *   T7: dashboard endpoint math — instant / recovered / missing / count / expected
 *   T8: pollTransactionsDelta writes rows via upsertPicksHistory with source='tx'
 *   T9: cursor derivation — max(completed_at) when present, fallback when empty
 *   T10: adaptive interval — 3 slow escalates; 10 fast ratchets back down
 *   T11: pagination — full page (length === PAGE_SIZE) triggers next-page fetch
 *
 * NOTE: T8-T11 reproduce pollTransactionsDelta logic locally for the same reason
 * T1-T7 reproduce upsertPicksHistory: importing itempath-adapter.js opens the
 * production DB at require-time. Keep the local copies in lockstep with the
 * adapter — if the algorithm changes there, mirror the change here.
 *
 * Usage: node scripts/test-picksync.js
 * Exits 0 on pass, 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// We can't use server/db.js directly (it opens the production DB on require).
// Reproduce the picks_history schema + the upsertPicksHistory logic locally —
// the schema must match db.js exactly or these tests are theatre.

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
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
      source TEXT DEFAULT NULL
    );
    CREATE UNIQUE INDEX idx_picks_hist_pick_id ON picks_history(pick_id);
    CREATE INDEX idx_picks_hist_completed ON picks_history(completed_at);
    CREATE INDEX idx_picks_hist_source ON picks_history(source);

    CREATE TABLE picks (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      reference TEXT,
      sku TEXT,
      name TEXT,
      qty INTEGER,
      picked INTEGER,
      pending INTEGER,
      warehouse TEXT,
      status TEXT,
      started_at TEXT,
      completed_at TEXT,
      archived INTEGER DEFAULT 0,
      synced_at TEXT
    );

    CREATE TABLE pickSync_attempted_days (
      date TEXT PRIMARY KEY,
      attempted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE delta_poll_cursor (
      type INTEGER PRIMARY KEY,
      cursor TEXT,
      updated_at INTEGER
    );
  `);
  return db;
}

// Mirror of db.js:getDeltaCursor / setDeltaCursor — used by the local
// _deriveDeltaCursor mirror and by the _drainType persistence call.
function makeDeltaCursorAccessors(db) {
  const getStmt = db.prepare(`SELECT cursor FROM delta_poll_cursor WHERE type = ?`);
  const setStmt = db.prepare(`
    INSERT INTO delta_poll_cursor (type, cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(type) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `);
  return {
    getDeltaCursor(type) {
      const row = getStmt.get(type);
      return row && row.cursor ? row.cursor : null;
    },
    setDeltaCursor(type, isoString, ms) {
      if (!isoString) return;
      setStmt.run(type, isoString, ms || Date.now());
    },
  };
}

// Mirror of db.js:upsertPicksHistory (post-rebuild). Kept here so tests can run
// standalone without hitting the production-DB-opening side effects of db.js.
const PICKS_HISTORY_MAX_QTY = 10000;
function makeUpsertPicksHistory(db) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const normalizeWarehouse = (raw) => {
    const wh = raw || '';
    if (/kitchen/i.test(wh) || /wh3/i.test(wh)) return 'WH3';
    if (/wh2/i.test(wh)) return 'WH2';
    if (/wh1/i.test(wh)) return 'WH1';
    return wh;
  };
  return function upsertPicksHistory(lines, source) {
    let inserted = 0, skipped = 0, rejected = 0;
    const src = source || null;
    const save = db.transaction(() => {
      for (const line of lines) {
        const sku = line.materialName || '';
        const qty = Math.abs(parseFloat(line.quantityConfirmed) || 0);
        if (!sku || qty <= 0) { skipped++; continue; }
        if (qty > PICKS_HISTORY_MAX_QTY) { rejected++; continue; }
        const orderName = line.orderName || line.orderId || '';
        const wh = normalizeWarehouse(line.warehouseName || line.costCenterName || '');
        const completedAt = line.modifiedDate || line.creationDate || new Date().toISOString();
        const pickId = line.pickId || `hist-${line.id || line.orderLineId || ''}`;
        const result = stmt.run(pickId, orderName, sku, orderName, qty, qty, wh, completedAt, src);
        if (result.changes > 0) inserted++;
      }
    });
    save();
    return { inserted, skipped, rejected, total: lines.length };
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const pendingTests = [];
function test(name, fn) {
  // Defer execution so both sync and async tests run inside the async main().
  pendingTests.push(async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
  });
}
function section(name) { pendingTests.push(async () => console.log(`\n${name}`)); }

// ─── T1: upsertPicksHistory writes source='live' ────────────────────────────
section('T1: source=live writer');
test('live-writer rows are tagged source=live', () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const lines = [{
    id: 'line-001', materialName: '7100012345', quantityConfirmed: 1,
    orderName: 'ORDER-001', warehouseName: 'WH1', modifiedDate: '2026-04-22 10:00-07:00',
  }];
  const r = upsert(lines, 'live');
  assert.equal(r.inserted, 1);
  const row = db.prepare(`SELECT * FROM picks_history WHERE pick_id = ?`).get('hist-line-001');
  assert.equal(row.source, 'live');
  assert.equal(row.sku, '7100012345');
  assert.equal(row.warehouse, 'WH1');
});

// ─── T2: upsertPicksHistory writes source='tx' ──────────────────────────────
section('T2: source=tx writer');
test('tx-writer rows are tagged source=tx with tx-<id> pickId', () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const lines = [{
    pickId: 'tx-tx-abc', id: 'tx-abc', materialName: '7100099999', quantityConfirmed: 2,
    orderName: 'ORDER-002', warehouseName: 'KITCHEN01', modifiedDate: '2026-04-22 11:00-07:00',
  }];
  const r = upsert(lines, 'tx');
  assert.equal(r.inserted, 1);
  const row = db.prepare(`SELECT * FROM picks_history WHERE pick_id = ?`).get('tx-tx-abc');
  assert.equal(row.source, 'tx');
  assert.equal(row.warehouse, 'WH3', 'KITCHEN01 → WH3 normalization');
});

// ─── T3: INSERT OR IGNORE preserves first writer ────────────────────────────
section('T3: INSERT OR IGNORE — first writer wins');
test('writing same pickId twice with different sources keeps the first', () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const baseLine = {
    pickId: 'tx-shared-1', id: 'shared-1', materialName: '7100055555',
    quantityConfirmed: 1, orderName: 'O', warehouseName: 'WH1',
    modifiedDate: '2026-04-22 12:00-07:00',
  };
  const r1 = upsert([{ ...baseLine }], 'tx');
  assert.equal(r1.inserted, 1);
  // Same pickId, different source — second write must be ignored.
  const r2 = upsert([{ ...baseLine, materialName: '7100099999' }], 'live');
  assert.equal(r2.inserted, 0, 'second write returns inserted=0');
  const row = db.prepare(`SELECT * FROM picks_history WHERE pick_id = ?`).get('tx-shared-1');
  assert.equal(row.source, 'tx', 'source remains tx (first writer)');
  assert.equal(row.sku, '7100055555', 'sku unchanged from first write');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM picks_history`).get().n;
  assert.equal(count, 1, 'still only one row');
});

// ─── T4: tx-writer dedupes against live-writer rows on shared pickId ────────
section('T4: tx-writer / live-writer pickId collision');
test('live-writer wrote hist-X; tx-writer with hist-X pickId is ignored', () => {
  // The tx-writer normally uses 'tx-<transaction_id>'. When a pick was already
  // captured by the live-writer with 'hist-<line.id>', the tx-writer's row has
  // a DIFFERENT pickId — so it would NOT collide. This test pins down the
  // intended dedupe surface: two writes under the SAME pickId space.
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const liveLine = {
    id: 'collide-1', materialName: 'M1', quantityConfirmed: 1,
    orderName: 'O1', warehouseName: 'WH1', modifiedDate: '2026-04-22T13:00:00Z',
  };
  upsert([liveLine], 'live'); // pickId becomes 'hist-collide-1'
  // Now the tx-writer somehow constructs the SAME pickId (legacy back-compat).
  const txCollide = { ...liveLine, pickId: 'hist-collide-1' };
  const r = upsert([txCollide], 'tx');
  assert.equal(r.inserted, 0);
  const rows = db.prepare(`SELECT * FROM picks_history WHERE pick_id = 'hist-collide-1'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'live');

  // And the realistic case: live wrote hist-X, tx writes tx-X — TWO rows
  // (both legitimate captures of the same physical pick from different angles).
  // This is by design: pickSync's BACKFILL also uses 'tx-' so it dedupes against
  // tx-writer; collision against live-writer is impossible by namespace.
  upsert([{ ...liveLine, pickId: 'tx-collide-1' }], 'tx');
  const all = db.prepare(`SELECT pick_id, source FROM picks_history ORDER BY pick_id`).all();
  assert.equal(all.length, 2, 'both hist-X and tx-X coexist');
  assert.deepEqual(all.map(r => r.pick_id), ['hist-collide-1', 'tx-collide-1']);
});

// ─── T5: BACKFILL loop guard ────────────────────────────────────────────────
section('T5: BACKFILL loop guard — diminishing returns');
test('inserted < 50 AND count > 0 → date marked attempted', () => {
  // Reproduce the guard logic inline (same conditions as the
  // itempath-adapter.js BACKFILL completion block).
  const db = makeDb();
  const dateStr = '2026-04-21';
  const missingDay = { dateStr, count: 1854 };  // partial coverage
  const totalFetched = 1900;
  const totalInserted = 12;                     // < 50 → guard fires
  const mode = 'BACKFILL';

  let markAttempted = false;
  let reason = '';
  if (mode === 'BACKFILL' && missingDay) {
    if (totalFetched === 0 && missingDay.count === 0) {
      markAttempted = true; reason = 'genuinely empty';
    } else if (totalInserted < 50 && missingDay.count > 0) {
      markAttempted = true; reason = `inserted ${totalInserted} on day with count ${missingDay.count}`;
    }
  }
  assert.equal(markAttempted, true);
  assert.match(reason, /inserted 12/);
  if (markAttempted) {
    db.prepare(`INSERT OR IGNORE INTO pickSync_attempted_days (date) VALUES (?)`).run(missingDay.dateStr);
  }
  const row = db.prepare(`SELECT * FROM pickSync_attempted_days WHERE date = ?`).get(dateStr);
  assert.ok(row, 'date row written to pickSync_attempted_days');

  // Negative case: 60 inserted on day with count > 0 → guard does NOT fire.
  let mark2 = false;
  const ti2 = 60;
  if (mode === 'BACKFILL' && missingDay) {
    if (ti2 < 50 && missingDay.count > 0) mark2 = true;
  }
  assert.equal(mark2, false, 'guard does not fire when >= 50 inserted');
});

// ─── T6: local recovery script logic ────────────────────────────────────────
section('T6: local recovery (picks → picks_history)');
test('archived pick with completed_at + no matching picks_history row → inserted with source=recovered', () => {
  const db = makeDb();
  // Seed a completed pick that the dual-writer missed (within-poll completion).
  db.prepare(`
    INSERT INTO picks (id, order_id, sku, name, qty, picked, warehouse, status,
                       started_at, completed_at, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, 1)
  `).run('ORD-1-7100012345', 'ORD-1', '7100012345', '7100012345', 1, 1, 'WH1',
         '2026-04-21 10:00-07:00', '2026-04-21 10:02-07:00');
  // Seed a second pick that ALREADY has a picks_history match — should NOT
  // be re-recovered. Match on (order_id, sku, completed_at-date).
  db.prepare(`
    INSERT INTO picks (id, order_id, sku, name, qty, picked, warehouse, status,
                       started_at, completed_at, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, 1)
  `).run('ORD-2-9999', 'ORD-2', '9999', 'X', 1, 1, 'WH1',
         '2026-04-21 11:00-07:00', '2026-04-21 11:01-07:00');
  db.prepare(`
    INSERT INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse,
                               completed_at, source)
    VALUES ('hist-existing', 'ORD-2', '9999', 'X', 1, 1, 'WH1',
            '2026-04-21 11:01-07:00', 'live')
  `).run();

  // Replicate the SELECT used by backfill-picks-history-from-picks.js
  const candidates = db.prepare(`
    SELECT p.id, p.order_id, p.sku, p.name, p.qty, p.warehouse, p.completed_at
    FROM picks p
    WHERE p.archived = 1
      AND p.completed_at IS NOT NULL
      AND p.completed_at >= datetime('now', '-30 days')
      AND NOT EXISTS (
        SELECT 1 FROM picks_history h
        WHERE h.order_id = p.order_id
          AND h.sku      = p.sku
          AND substr(h.completed_at, 1, 10) = substr(p.completed_at, 1, 10)
      )
  `).all();
  assert.equal(candidates.length, 1, 'only the un-recovered pick is a candidate');
  assert.equal(candidates[0].id, 'ORD-1-7100012345');

  // Apply the insert.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO picks_history
      (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recovered')
  `);
  for (const c of candidates) {
    insert.run(`rec-${c.id}`, c.order_id, c.sku, c.name, c.qty, c.qty, c.warehouse, c.completed_at);
  }
  const recovered = db.prepare(`SELECT * FROM picks_history WHERE source = 'recovered'`).all();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].pick_id, 'rec-ORD-1-7100012345');

  // Idempotency: running the same insert again is a no-op.
  for (const c of candidates) {
    insert.run(`rec-${c.id}`, c.order_id, c.sku, c.name, c.qty, c.qty, c.warehouse, c.completed_at);
  }
  const recovered2 = db.prepare(`SELECT COUNT(*) AS n FROM picks_history WHERE source = 'recovered'`).get().n;
  assert.equal(recovered2, 1, 'INSERT OR IGNORE keeps it at one row');
});

// ─── T7: dashboard endpoint math ────────────────────────────────────────────
section('T7: dashboard endpoint per-day math');
test('instant + recovered + missing math matches expected', () => {
  const db = makeDb();
  const insert = db.prepare(`
    INSERT INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
    VALUES (?, ?, ?, ?, 1, 1, 'WH1', ?, ?)
  `);
  // 2026-04-22 (Wednesday — expected 2500)
  // 1500 instant + 200 recovered + 50 NULL legacy → count=1750, missing=750
  for (let i = 0; i < 1500; i++) insert.run(`live-${i}`, 'O', 'SKU', 'SKU', '2026-04-22 10:00-07:00', i % 2 === 0 ? 'live' : 'tx');
  for (let i = 0; i < 200;  i++) insert.run(`bf-${i}`,   'O', 'SKU', 'SKU', '2026-04-22 11:00-07:00', i % 2 === 0 ? 'backfill' : 'recovered');
  for (let i = 0; i < 50;   i++) insert.run(`legacy-${i}`,'O', 'SKU', 'SKU', '2026-04-22 12:00-07:00', null);

  // Replicate the endpoint SQL.
  const rows = db.prepare(`
    SELECT substr(completed_at, 1, 10) AS date,
           SUM(CASE WHEN source IN ('live','tx') THEN 1 ELSE 0 END) AS instant,
           SUM(CASE WHEN source IN ('backfill','recovered') THEN 1 ELSE 0 END) AS recovered,
           COUNT(*) AS count
    FROM picks_history
    GROUP BY substr(completed_at, 1, 10)
  `).all();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.date, '2026-04-22');
  assert.equal(r.instant, 1500);
  assert.equal(r.recovered, 200);
  assert.equal(r.count, 1750);

  // Apply the endpoint's coverage math.
  const expected = 2500; // weekday
  const missing = Math.max(0, expected - r.count);
  assert.equal(missing, 750);
  const pct = Math.min(100, Math.round((r.count / expected) * 100));
  assert.equal(pct, 70);
});

test('day with count > expected has missing = 0 (floored)', () => {
  const db = makeDb();
  const insert = db.prepare(`
    INSERT INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
    VALUES (?, 'O', 'SKU', 'SKU', 1, 1, 'WH1', '2026-04-22 10:00-07:00', 'live')
  `);
  for (let i = 0; i < 3000; i++) insert.run(`x-${i}`);
  const r = db.prepare(`
    SELECT COUNT(*) AS count,
           SUM(CASE WHEN source IN ('live','tx') THEN 1 ELSE 0 END) AS instant,
           SUM(CASE WHEN source IN ('backfill','recovered') THEN 1 ELSE 0 END) AS recovered
    FROM picks_history
  `).get();
  const expected = 2500;
  const missing = Math.max(0, expected - r.count);
  assert.equal(missing, 0);
  assert.equal(r.instant, 3000);
});

// ─── Delta-poll local mirror (must track itempath-adapter.js exactly) ───────
const DELTA_POLL_TIERS = [30000, 60000, 120000, 300000];
const DELTA_POLL_SLOW_MS = 500;
const DELTA_POLL_PAGE_SIZE = 500;
const DELTA_POLL_MAX_PAGES = 10;
const DELTA_POLL_OVERLAP_MS = 30 * 1000;
const DELTA_POLL_FALLBACK_MS = 5 * 60 * 1000;
const DELTA_POLL_RATCHET_DOWN_FAST = 10;

function makeDeltaState() {
  return {
    interval: DELTA_POLL_TIERS[0],
    consecutiveSlow: 0,
    consecutiveErrors: 0,
    consecutiveFast: 0,
    lastRunAt: null,
    lastLatencyMs: null,
    lastBatchSize: null,
    lastError: null,
    lastCursor: null,
  };
}

function deriveDeltaCursor(db, type, accessors) {
  // Take the HIGHER of (a) persisted per-type cursor and (b) max(completed_at)
  // from picks_history minus 30s overlap. Mirrors itempath-adapter.js.
  let dbCursorMs = -Infinity;
  let historyCursorMs = -Infinity;
  if (type !== undefined && type !== null && accessors) {
    const persisted = accessors.getDeltaCursor(type);
    if (persisted) {
      const t = new Date(persisted).getTime();
      if (!Number.isNaN(t)) dbCursorMs = t;
    }
  }
  const row = db.prepare(`
    SELECT MAX(completed_at) AS max_completed
    FROM picks_history
    WHERE source IN ('live','tx','backfill') AND completed_at IS NOT NULL
  `).get();
  if (row && row.max_completed) {
    const t = new Date(row.max_completed).getTime();
    if (!Number.isNaN(t)) historyCursorMs = t - DELTA_POLL_OVERLAP_MS;
  }
  const best = Math.max(dbCursorMs, historyCursorMs);
  if (Number.isFinite(best)) return new Date(best).toISOString();
  return new Date(Date.now() - DELTA_POLL_FALLBACK_MS).toISOString();
}

function txToLine(tx) {
  if (!tx || !tx.id) return null;
  const sku = tx.materialName || '';
  const qty = Math.abs(parseFloat(tx.quantityConfirmed) || 0);
  if (!sku || qty <= 0) return null;
  return {
    pickId: `tx-${tx.id}`,
    id: tx.id,
    materialName: sku,
    quantityConfirmed: qty,
    orderName: tx.orderName || tx.orderId || tx.id,
    warehouseName: tx.warehouseName || '',
    modifiedDate: tx.creationDate || tx.modifiedDate || new Date().toISOString(),
  };
}

async function drainType(ipFetchFn, upsert, type, startCursor, accessors) {
  let cursor = startCursor;
  let totalLines = 0, totalInserted = 0, pages = 0;
  for (let p = 0; p < DELTA_POLL_MAX_PAGES; p++) {
    const resp = await ipFetchFn('/api/transactions', { type, after: cursor, limit: DELTA_POLL_PAGE_SIZE });
    const rawTx = (resp && (resp.transactions || resp.data || resp)) || [];
    if (!Array.isArray(rawTx) || rawTx.length === 0) break;
    pages++;
    const lines = [];
    for (const tx of rawTx) { const l = txToLine(tx); if (l) lines.push(l); }
    let pageInserted = 0;
    if (lines.length > 0) {
      const { inserted } = upsert(lines, 'tx');
      pageInserted = inserted;
      totalInserted += inserted;
    }
    totalLines += rawTx.length;
    const last = rawTx[rawTx.length - 1];
    const lastTs = last && (last.creationDate || last.modifiedDate);
    if (lastTs && accessors) {
      let toPersist = lastTs;
      if (pageInserted === 0 && rawTx.length === DELTA_POLL_PAGE_SIZE) {
        const ms = new Date(lastTs).getTime();
        if (!Number.isNaN(ms)) toPersist = new Date(ms + 1).toISOString();
      }
      accessors.setDeltaCursor(type, toPersist, Date.now());
    }
    if (rawTx.length < DELTA_POLL_PAGE_SIZE) break;
    if (!lastTs) break;
    cursor = lastTs;
  }
  return { fetched: totalLines, inserted: totalInserted, pages };
}

async function pollTransactionsDelta(state, ipFetchFn, db, upsert, conservation = false, accessors = null) {
  if (conservation) return { skipped: true };
  const picksCursor = deriveDeltaCursor(db, 4, accessors);
  const putsCursor  = deriveDeltaCursor(db, 3, accessors);
  state.lastCursor = (new Date(picksCursor).getTime() <= new Date(putsCursor).getTime())
    ? picksCursor : putsCursor;
  const t0 = Date.now();
  try {
    const picks = await drainType(ipFetchFn, upsert, 4, picksCursor, accessors);
    const puts  = await drainType(ipFetchFn, upsert, 3, putsCursor,  accessors);
    const latency = Date.now() - t0;
    state.lastRunAt = new Date().toISOString();
    state.lastLatencyMs = latency;
    state.lastBatchSize = picks.fetched + puts.fetched;
    state.lastError = null;
    if (latency > DELTA_POLL_SLOW_MS) {
      state.consecutiveSlow++;
      state.consecutiveFast = 0;
      if (state.consecutiveSlow >= 3) {
        const idx = DELTA_POLL_TIERS.indexOf(state.interval);
        if (idx < DELTA_POLL_TIERS.length - 1) state.interval = DELTA_POLL_TIERS[idx + 1];
        state.consecutiveSlow = 0;
      }
    } else {
      state.consecutiveSlow = 0;
      state.consecutiveErrors = 0;
      state.consecutiveFast++;
      if (state.interval > DELTA_POLL_TIERS[0] && state.consecutiveFast >= DELTA_POLL_RATCHET_DOWN_FAST) {
        const idx = DELTA_POLL_TIERS.indexOf(state.interval);
        if (idx > 0) state.interval = DELTA_POLL_TIERS[idx - 1];
        state.consecutiveFast = 0;
      }
    }
    return { picks, puts, latency, picksCursor, putsCursor };
  } catch (e) {
    const latency = Date.now() - t0;
    state.lastError = e.message;
    state.consecutiveErrors++;
    state.consecutiveFast = 0;
    if (state.consecutiveErrors >= 3) {
      const idx = DELTA_POLL_TIERS.indexOf(state.interval);
      if (idx < DELTA_POLL_TIERS.length - 1) state.interval = DELTA_POLL_TIERS[idx + 1];
      state.consecutiveErrors = 0;
    }
    return { error: e.message, latency, picksCursor, putsCursor };
  }
}

// ─── T8: pollTransactionsDelta writes rows with source='tx' ─────────────────
section('T8: delta-poll writes via upsertPicksHistory with source=tx');
test('mock fetch returns 2 picks + 1 put → 3 rows in picks_history with source=tx', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();

  // Seed an existing row so cursor derivation has something to anchor on.
  upsert([{
    id: 'seed-1', materialName: 'SEED', quantityConfirmed: 1,
    orderName: 'O-SEED', warehouseName: 'WH1',
    modifiedDate: '2026-04-22T10:00:00.000Z',
  }], 'live');

  const responsesByType = {
    4: [
      { id: 'TX-100', materialName: '7100012345', quantityConfirmed: 1,
        orderName: 'ORD-100', warehouseName: 'WH1',
        creationDate: '2026-04-22T10:05:00.000Z' },
      { id: 'TX-101', materialName: '7100099999', quantityConfirmed: 2,
        orderName: 'ORD-101', warehouseName: 'KITCHEN01',
        creationDate: '2026-04-22T10:06:00.000Z' },
    ],
    3: [
      { id: 'PUT-200', materialName: '7100055555', quantityConfirmed: 5,
        orderName: 'PUT-WH2-200', warehouseName: 'WH2',
        creationDate: '2026-04-22T10:07:00.000Z' },
    ],
  };
  let calls = 0;
  const ipFetchFn = async (_path, params) => {
    calls++;
    return { transactions: responsesByType[params.type] || [] };
  };

  const result = await pollTransactionsDelta(state, ipFetchFn, db, upsert);
  assert.equal(result.picks.fetched, 2);
  assert.equal(result.picks.inserted, 2);
  assert.equal(result.puts.fetched, 1);
  assert.equal(result.puts.inserted, 1);
  assert.equal(calls, 2, 'one call per type (no pagination)');

  const rows = db.prepare(`SELECT pick_id, source, sku, warehouse FROM picks_history WHERE pick_id LIKE 'tx-%' ORDER BY pick_id`).all();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.pick_id), ['tx-PUT-200', 'tx-TX-100', 'tx-TX-101']);
  assert.ok(rows.every(r => r.source === 'tx'));
  // Warehouse normalization on KITCHEN01.
  const tx101 = rows.find(r => r.pick_id === 'tx-TX-101');
  assert.equal(tx101.warehouse, 'WH3');
});

// ─── T9: cursor derivation ──────────────────────────────────────────────────
section('T9: cursor derivation — max(completed_at) vs fallback');
test('non-empty picks_history → cursor = max(completed_at) - 30s overlap', () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  upsert([
    { id: 'a', materialName: 'X', quantityConfirmed: 1, orderName: 'O', warehouseName: 'WH1',
      modifiedDate: '2026-04-22T10:00:00.000Z' },
    { id: 'b', materialName: 'X', quantityConfirmed: 1, orderName: 'O', warehouseName: 'WH1',
      modifiedDate: '2026-04-22T10:30:00.000Z' },
  ], 'live');
  const cursor = deriveDeltaCursor(db);
  // 10:30 minus 30s = 10:29:30
  assert.equal(cursor, '2026-04-22T10:29:30.000Z');
});

test('empty picks_history → cursor = now - 5min fallback', () => {
  const db = makeDb();
  const before = Date.now();
  const cursor = deriveDeltaCursor(db);
  const cursorMs = new Date(cursor).getTime();
  const after = Date.now();
  // Cursor should be ~5 min ago, sitting between (before-5min) and (after-5min).
  assert.ok(cursorMs >= before - DELTA_POLL_FALLBACK_MS - 5);
  assert.ok(cursorMs <= after - DELTA_POLL_FALLBACK_MS + 5);
});

test('only recovered/legacy rows present → still falls back (excluded by source filter)', () => {
  const db = makeDb();
  // recovered + null source — both excluded by the WHERE clause.
  db.prepare(`INSERT INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
              VALUES ('rec-1','O','S','S',1,1,'WH1','2030-01-01T00:00:00.000Z','recovered')`).run();
  db.prepare(`INSERT INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at, source)
              VALUES ('leg-1','O','S','S',1,1,'WH1','2030-01-01T00:00:00.000Z',NULL)`).run();
  const cursor = deriveDeltaCursor(db);
  // If derivation incorrectly used either of those rows we'd get 2030; ensure we got the 5-min fallback.
  const cursorMs = new Date(cursor).getTime();
  assert.ok(cursorMs < Date.now(), 'cursor must not be in the future');
  assert.ok(Date.now() - cursorMs >= DELTA_POLL_FALLBACK_MS - 5);
});

// ─── T10: adaptive interval ─────────────────────────────────────────────────
section('T10: adaptive interval — 3 slow escalates, 10 fast ratchets back');
test('3 consecutive slow (>500ms) responses bump 30s → 60s', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();
  // Real latency so we don't have to monkey-patch the clock. 260ms × 2 endpoints
  // per tick = ~520ms per poll → crosses DELTA_POLL_SLOW_MS=500.
  const slowFetch = () => new Promise(res => setTimeout(() => res({ transactions: [] }), 260));
  for (let i = 0; i < 3; i++) {
    await pollTransactionsDelta(state, slowFetch, db, upsert);
  }
  assert.equal(state.interval, 60000, 'escalated to 60s after 3 slow calls');
});

test('2 slow then 1 fast resets slow counter (no escalation)', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();
  const slowFetch = () => new Promise(res => setTimeout(() => res({ transactions: [] }), 260));
  const fastFetch = async () => ({ transactions: [] });
  for (let i = 0; i < 2; i++) await pollTransactionsDelta(state, slowFetch, db, upsert);
  assert.equal(state.consecutiveSlow, 2);
  await pollTransactionsDelta(state, fastFetch, db, upsert);
  assert.equal(state.consecutiveSlow, 0);
  assert.equal(state.interval, 30000, 'no escalation occurred');
});

test('10 consecutive fast calls at 60s tier ratchets back to 30s', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();
  state.interval = 60000; // pretend we're already escalated
  const fastFetch = async () => ({ transactions: [] });
  for (let i = 0; i < 10; i++) {
    await pollTransactionsDelta(state, fastFetch, db, upsert);
  }
  assert.equal(state.interval, 30000, 'ratcheted back to base tier');
});

test('3 consecutive errors escalate', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();
  const errFetch = async () => { throw new Error('HTTP 500'); };
  for (let i = 0; i < 3; i++) {
    await pollTransactionsDelta(state, errFetch, db, upsert);
  }
  assert.equal(state.interval, 60000);
  assert.equal(state.lastError, 'HTTP 500');
});

// ─── T11: pagination ────────────────────────────────────────────────────────
section('T11: pagination — full page triggers next-page fetch');
test('response length === 500 advances cursor to last row creationDate, fetches again', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();

  // Build 500 picks for page 1, 5 picks for page 2 (short page → stop).
  const page1 = [];
  for (let i = 0; i < 500; i++) {
    page1.push({
      id: `p1-${i}`, materialName: 'M', quantityConfirmed: 1,
      orderName: `O-${i}`, warehouseName: 'WH1',
      creationDate: `2026-04-22T11:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`,
    });
  }
  const lastP1Ts = page1[page1.length - 1].creationDate;
  const page2 = [];
  for (let i = 0; i < 5; i++) {
    page2.push({
      id: `p2-${i}`, materialName: 'M', quantityConfirmed: 1,
      orderName: `O-p2-${i}`, warehouseName: 'WH1',
      creationDate: `2026-04-22T12:00:0${i}.000Z`,
    });
  }

  const callLog = [];
  const ipFetchFn = async (_path, params) => {
    callLog.push({ type: params.type, after: params.after });
    if (params.type !== 4) return { transactions: [] }; // puts: nothing
    if (params.after === lastP1Ts) return { transactions: page2 };
    return { transactions: page1 };
  };

  const result = await pollTransactionsDelta(state, ipFetchFn, db, upsert);
  assert.equal(result.picks.fetched, 505);
  assert.equal(result.picks.inserted, 505);
  assert.equal(result.picks.pages, 2);

  // Two type=4 calls: first with the derived cursor, second with lastP1Ts.
  const type4Calls = callLog.filter(c => c.type === 4);
  assert.equal(type4Calls.length, 2);
  assert.equal(type4Calls[1].after, lastP1Ts, 'second page used last row creationDate as cursor');

  const count = db.prepare(`SELECT COUNT(*) AS n FROM picks_history WHERE pick_id LIKE 'tx-%'`).get().n;
  assert.equal(count, 505);
});

test('safety cap — 10 consecutive full pages stops the loop', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const state = makeDeltaState();
  let calls = 0;
  // Always return a full page with a unique terminal timestamp so the cursor advances.
  const ipFetchFn = async (_path, params) => {
    if (params.type !== 4) return { transactions: [] };
    calls++;
    const page = [];
    for (let i = 0; i < 500; i++) {
      page.push({
        id: `c${calls}-${i}`, materialName: 'M', quantityConfirmed: 1,
        orderName: 'O', warehouseName: 'WH1',
        creationDate: `2026-04-22T${String(10 + calls).padStart(2,'0')}:00:${String(i%60).padStart(2,'0')}.000Z`,
      });
    }
    return { transactions: page };
  };
  const result = await pollTransactionsDelta(state, ipFetchFn, db, upsert);
  assert.equal(result.picks.pages, 10, 'capped at MAX_PAGES');
  assert.equal(calls, 10);
});

// ─── T12: hung ipFetch must not block the next scheduled tick ───────────────
// Reproduces the 2026-04-22 crash-loop: a hung fetch on one tick used to
// block the entire delta-poll chain (no next tick scheduled → silent death).
// The fix schedules the next tick BEFORE awaiting — concurrent ticks are safe
// because INSERT OR IGNORE on pick_id dedupes.
section('T12: hung ipFetch does not break the delta-poll chain');
test('rescheduling fires even while the prior tick is still awaiting', async () => {
  // Local mirror of _scheduleDeltaPoll's "reschedule first, then await"
  // pattern. Keep this in lockstep with itempath-adapter.js#_scheduleDeltaPoll.
  const INTERVAL_MS = 10;           // tiny interval so the test stays fast
  const TICK_DEADLINE_MS = 200;     // bound on how long we wait for ≥2 ticks
  const tickStarts = [];
  let timer = null;
  let stopped = false;

  // A fetch that never resolves — simulates the hung head-of-line case.
  let resolveHung;
  const hungFetch = () => new Promise((resolve) => { resolveHung = resolve; });

  // Minimal pollTransactionsDelta stub — records tick start, then awaits the
  // hung fetch. If scheduling works, a SECOND tick start must still occur
  // before we even resolve the first.
  async function pollStub() {
    tickStarts.push(Date.now());
    await hungFetch();
    return { ok: true };
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      // Reschedule FIRST — the fix under test.
      schedule();
      // Then await the (hung) work — errors must not break the chain.
      pollStub().catch(() => {});
    }, INTERVAL_MS);
  }

  schedule();

  // Wait until at least 2 tick starts are observed or the deadline fires.
  const start = Date.now();
  while (tickStarts.length < 2 && Date.now() - start < TICK_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Cleanup before assertions so test failures don't leave timers running.
  stopped = true;
  if (timer) clearTimeout(timer);
  if (resolveHung) resolveHung({ transactions: [] });

  assert.ok(tickStarts.length >= 2,
    `expected >=2 tick starts while first tick hung; got ${tickStarts.length}`);
});

// ─── T13: cursor advances on all-dupes tick ─────────────────────────────────
// Reproduces the §3 stuck-cursor bug: a full page where every row is already
// in picks_history (INSERT OR IGNORE returns inserted=0). Without persistence
// + the +1ms tie-break, MAX(completed_at) doesn't move and the next tick
// refetches the same window forever.
section('T13: cursor advances even when every fetched row is a dupe');
test('full page of all-dupes persists cursor + bumps by +1ms', async () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const accessors = makeDeltaCursorAccessors(db);
  const state = makeDeltaState();

  // Seed picks_history with 500 rows that the next fetch will return verbatim.
  const dupePage = [];
  for (let i = 0; i < 500; i++) {
    const ts = `2026-04-22T10:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`;
    dupePage.push({
      id: `dup-${i}`, materialName: 'M', quantityConfirmed: 1,
      orderName: `O-${i}`, warehouseName: 'WH1',
      creationDate: ts,
    });
    // Pre-insert so that the tx-writer's pickId 'tx-dup-N' is ALREADY in history.
    upsert([{
      pickId: `tx-dup-${i}`, id: `dup-${i}`, materialName: 'M', quantityConfirmed: 1,
      orderName: `O-${i}`, warehouseName: 'WH1', modifiedDate: ts,
    }], 'tx');
  }
  const lastTs = dupePage[dupePage.length - 1].creationDate;

  const ipFetchFn = async (_p, params) => {
    if (params.type !== 4) return { transactions: [] };
    // Return the same dupe page only ONCE; subsequent calls return empty so
    // the safety cap doesn't fire. After the first page we expect cursor to
    // be persisted at lastTs+1ms — page 2 fetch should use that as `after`.
    if (params.after === lastTs || params.after === new Date(new Date(lastTs).getTime()+1).toISOString()) {
      return { transactions: [] };
    }
    return { transactions: dupePage };
  };

  const before = accessors.getDeltaCursor(4);
  assert.equal(before, null, 'no persisted cursor before tick');

  const result = await pollTransactionsDelta(state, ipFetchFn, db, upsert, false, accessors);
  assert.equal(result.picks.fetched, 500);
  assert.equal(result.picks.inserted, 0, 'all rows were dupes');

  const after = accessors.getDeltaCursor(4);
  assert.ok(after, 'cursor was persisted');
  const expectedMs = new Date(lastTs).getTime() + 1;
  assert.equal(new Date(after).getTime(), expectedMs,
    `cursor bumped by +1ms (got ${after}, expected ${new Date(expectedMs).toISOString()})`);
});

// ─── T14: persisted cursor survives "process restart" ───────────────────────
// Restart simulated by discarding the in-memory state and re-deriving from db.
// The persisted cursor must outrank the picks_history MAX(completed_at) when
// it's higher (the all-dupes-bumped case).
section('T14: persisted cursor survives a process restart');
test('after restart, deriveDeltaCursor returns the persisted cursor (not the history MAX)', () => {
  const db = makeDb();
  const upsert = makeUpsertPicksHistory(db);
  const accessors = makeDeltaCursorAccessors(db);

  // Seed picks_history with rows up to 10:00:00. Then persist a cursor at 11:00:00 —
  // simulates the all-dupes bump landing past the history MAX.
  upsert([{
    id: 'a', materialName: 'X', quantityConfirmed: 1, orderName: 'O', warehouseName: 'WH1',
    modifiedDate: '2026-04-22T10:00:00.000Z',
  }], 'live');
  const persistedAt = '2026-04-22T11:00:00.001Z';
  accessors.setDeltaCursor(4, persistedAt, Date.now());

  // "Restart": new derivation call with no in-memory state.
  const c4 = deriveDeltaCursor(db, 4, accessors);
  assert.equal(c4, persistedAt,
    'persisted cursor wins over history MAX when it is higher');

  // Sanity: type=3 has no persisted cursor → falls back to history MAX - 30s.
  const c3 = deriveDeltaCursor(db, 3, accessors);
  assert.equal(c3, '2026-04-22T09:59:30.000Z');

  // And: persisted cursor BEHIND history MAX → history wins.
  accessors.setDeltaCursor(3, '2026-04-21T00:00:00.000Z', Date.now());
  const c3b = deriveDeltaCursor(db, 3, accessors);
  assert.equal(c3b, '2026-04-22T09:59:30.000Z',
    'history MAX-30s wins when it is higher than the persisted cursor');
});

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  for (const step of pendingTests) await step();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
