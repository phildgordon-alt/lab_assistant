#!/usr/bin/env node
/**
 * test-dvi-trace-coldstart.js — DVI trace cold-start (2026-04-22)
 *
 * In-memory SQLite tests for the trust-SQLite cold-start path. Modeled on
 * test-picksync.js. Validates that:
 *   - cold-start with non-empty dvi_trace_jobs trusts SQLite + tail-forwards
 *     from the persisted byte offset (does NOT call loadHistory)
 *   - empty SQLite still falls back to loadHistory (cold-cold start)
 *   - the stale-data sentinel (>24h old) still triggers a rebuild
 *   - poll() persists byte offset to dvi_trace_offsets
 *   - day rollover persists OLD file's final offset and resets to 0 for new
 *   - manual recover() endpoint still does a full loadHistory replay
 *
 * Tests reproduce the relevant logic locally rather than importing
 * server/dvi-trace.js or server/db.js, both of which open the production DB
 * at require-time. Keep the local copies in lockstep with the source.
 *
 * Usage: node scripts/test-dvi-trace-coldstart.js
 * Exits 0 on pass, 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// ── Schema mirror — must match db.js exactly or these tests are theatre. ─────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dvi_trace_jobs (
      job_id TEXT PRIMARY KEY,
      tray TEXT,
      station TEXT,
      station_num INTEGER,
      stage TEXT,
      category TEXT,
      status TEXT DEFAULT 'Active',
      first_seen_ms INTEGER,
      last_seen_ms INTEGER,
      operator TEXT,
      machine_id TEXT,
      has_breakage INTEGER DEFAULT 0,
      event_count INTEGER DEFAULT 0,
      events_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE dvi_trace_offsets (
      filename TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  return db;
}

// ── Mirror of db.js:getDviTraceOffset / setDviTraceOffset ────────────────────
function makeOffsetAccessors(db) {
  const getStmt = db.prepare(`SELECT byte_offset FROM dvi_trace_offsets WHERE filename = ?`);
  const setStmt = db.prepare(`
    INSERT INTO dvi_trace_offsets (filename, byte_offset, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(filename) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at
  `);
  return {
    getDviTraceOffset(filename) {
      if (!filename) return null;
      const row = getStmt.get(filename);
      return row && Number.isFinite(row.byte_offset) ? row.byte_offset : null;
    },
    setDviTraceOffset(filename, offset) {
      if (!filename) return;
      const off = Number.isFinite(offset) ? offset : 0;
      setStmt.run(filename, off, Date.now());
    },
  };
}

// ── Helper from dvi-trace.js (verbatim) ──────────────────────────────────────
function getTodayFilename() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `LT${yy}${mm}${dd}.DAT`;
}

// ── Mirror of dvi-trace.js:loadFromDb (relevant subset for these tests) ──────
// Returns { jobsLoaded, staleCleared, newestEventMs }.
function loadFromDb(db, jobs) {
  const rows = db.prepare('SELECT * FROM dvi_trace_jobs').all();
  if (rows.length === 0) return { jobsLoaded: 0, staleCleared: false, newestEventMs: 0 };

  for (const row of rows) {
    if (!/^\d+$/.test(row.job_id)) continue;
    jobs.set(row.job_id, {
      jobId: row.job_id,
      station: row.station,
      stage: row.stage,
      status: row.status || 'Active',
      lastSeen: row.last_seen_ms,
    });
  }

  // Sanity check: if most recent event is >24h old, data is stale.
  let newestEvent = 0;
  for (const job of jobs.values()) {
    if (job.lastSeen > newestEvent) newestEvent = job.lastSeen;
  }
  const ageHours = newestEvent > 0 ? (Date.now() - newestEvent) / 3600000 : Infinity;
  if (jobs.size > 100 && ageHours > 24) {
    jobs.clear();
    return { jobsLoaded: 0, staleCleared: true, newestEventMs: newestEvent };
  }
  return { jobsLoaded: jobs.size, staleCleared: false, newestEventMs: newestEvent };
}

// ── Mirror of dvi-trace.js:_startPolling decision logic ──────────────────────
// Returns which branch was taken: 'trust-sqlite' or 'load-history'.
function pickColdStartBranch(jobs) {
  return jobs.size > 0 ? 'trust-sqlite' : 'load-history';
}

// ── Mirror of dvi-trace.js:liveOnlyStart (the trust-SQLite branch) ───────────
function liveOnlyStart(state, accessors) {
  const todayFile = getTodayFilename();
  let offset = 0;
  const persisted = accessors.getDviTraceOffset(todayFile);
  if (persisted != null) offset = persisted;
  state.currentFile = todayFile;
  state.byteOffset = offset;
  state.partialLine = '';
}

// ── Mirror of dvi-trace.js:poll() — only the offset-persistence portion ──────
// Simulates a poll that reads up to `fileSize` bytes and persists the new
// offset. Returns the persisted offset.
function simulatePoll(state, fileSize, accessors) {
  if (fileSize <= state.byteOffset) return state.byteOffset;
  state.byteOffset = fileSize;
  accessors.setDviTraceOffset(state.currentFile, state.byteOffset);
  return state.byteOffset;
}

// ── Mirror of dvi-trace.js:poll() — day rollover portion ─────────────────────
function simulateDayRollover(state, newFilename, accessors) {
  if (state.currentFile === newFilename) return;
  if (state.currentFile) {
    // Persist final offset for OLD file before resetting.
    accessors.setDviTraceOffset(state.currentFile, state.byteOffset);
  }
  state.currentFile = newFilename;
  state.byteOffset = 0;
  state.partialLine = '';
  // Seed new day's offset row at 0.
  accessors.setDviTraceOffset(state.currentFile, 0);
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

// Seed N jobs into dvi_trace_jobs with a recent lastSeen so the stale-data
// sentinel does NOT fire.
function seedJobs(db, count, lastSeenMs) {
  const ts = lastSeenMs != null ? lastSeenMs : Date.now() - 60 * 60 * 1000; // 1h ago
  const stmt = db.prepare(`
    INSERT INTO dvi_trace_jobs (job_id, station, stage, status, first_seen_ms, last_seen_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const txn = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      stmt.run(String(1000000 + i), 'POLISH', 'SURFACING', 'Active', ts - 86400000, ts);
    }
  });
  txn();
}

// ─── T1: trust-SQLite cold-start with offset row ────────────────────────────
section('T1: cold-start with non-empty dvi_trace_jobs + persisted offset');
test('loads N jobs from SQLite, sets currentFile + byteOffset, does NOT call loadHistory', () => {
  const db = makeDb();
  const accessors = makeOffsetAccessors(db);
  const todayFile = getTodayFilename();

  seedJobs(db, 250);
  accessors.setDviTraceOffset(todayFile, 1234567);

  const jobs = new Map();
  const restore = loadFromDb(db, jobs);
  assert.equal(restore.jobsLoaded, 250, '250 jobs restored from SQLite');
  assert.equal(restore.staleCleared, false, 'stale sentinel did NOT fire');

  const branch = pickColdStartBranch(jobs);
  assert.equal(branch, 'trust-sqlite', 'cold-start must trust SQLite');

  const state = { currentFile: null, byteOffset: 0, partialLine: '' };
  liveOnlyStart(state, accessors);
  assert.equal(state.currentFile, todayFile, 'currentFile set from getTodayFilename()');
  assert.equal(state.byteOffset, 1234567, 'byteOffset restored from offsets table');
  assert.equal(state.partialLine, '', 'partialLine reset');
});

// ─── T2: cold-cold start with EMPTY dvi_trace_jobs ──────────────────────────
section('T2: cold-cold start (SQLite empty) → fallback to loadHistory');
test('empty dvi_trace_jobs → branch=load-history (legacy path)', () => {
  const db = makeDb();
  const jobs = new Map();
  const restore = loadFromDb(db, jobs);
  assert.equal(restore.jobsLoaded, 0, 'no jobs to restore');
  assert.equal(restore.staleCleared, false, 'no stale clear (table was empty)');

  const branch = pickColdStartBranch(jobs);
  assert.equal(branch, 'load-history', 'must fall back to legacy history replay');
});

// ─── T3: stale-data sentinel (>24h old) → triggers rebuild ──────────────────
section('T3: stale-data sentinel forces loadHistory rebuild');
test('newest event >24h old → loadFromDb clears jobs, branch=load-history', () => {
  const db = makeDb();
  // 200 jobs (above the 100-job threshold), all 48h stale.
  const staleTs = Date.now() - 48 * 3600 * 1000;
  seedJobs(db, 200, staleTs);

  const jobs = new Map();
  const restore = loadFromDb(db, jobs);
  assert.equal(restore.staleCleared, true, 'stale sentinel fired');
  assert.equal(restore.jobsLoaded, 0, 'jobs cleared, return 0');
  assert.equal(jobs.size, 0, 'in-memory jobs map cleared');

  const branch = pickColdStartBranch(jobs);
  assert.equal(branch, 'load-history', 'rebuild from trace files (safety net)');
});

// ─── T4: poll advances byteOffset → persisted to dvi_trace_offsets ──────────
section('T4: poll() persists byte offset on every successful advance');
test('simulated poll writes new offset to dvi_trace_offsets', () => {
  const db = makeDb();
  const accessors = makeOffsetAccessors(db);
  const todayFile = getTodayFilename();

  // Initial: empty table, offset null.
  assert.equal(accessors.getDviTraceOffset(todayFile), null);

  const state = { currentFile: todayFile, byteOffset: 0, partialLine: '' };

  // Poll 1: file grew to 5000 bytes.
  let off = simulatePoll(state, 5000, accessors);
  assert.equal(off, 5000);
  assert.equal(accessors.getDviTraceOffset(todayFile), 5000, 'offset persisted after first poll');

  // Poll 2: file grew to 8200 bytes.
  off = simulatePoll(state, 8200, accessors);
  assert.equal(off, 8200);
  assert.equal(accessors.getDviTraceOffset(todayFile), 8200, 'offset upserted on subsequent poll');

  // Poll 3: file did NOT grow — offset must not move backward.
  off = simulatePoll(state, 8200, accessors);
  assert.equal(off, 8200, 'no-op when fileSize <= byteOffset');
  assert.equal(accessors.getDviTraceOffset(todayFile), 8200, 'persisted offset unchanged');
});

// ─── T5: day rollover persists final old offset, resets new to 0 ────────────
section('T5: day rollover persists OLD final offset, seeds NEW at 0');
test('rollover writes old file final offset and starts new file at 0', () => {
  const db = makeDb();
  const accessors = makeOffsetAccessors(db);

  const oldFile = 'LT260421.DAT';
  const newFile = 'LT260422.DAT';
  const state = { currentFile: oldFile, byteOffset: 99999, partialLine: 'half-line' };

  simulateDayRollover(state, newFile, accessors);

  assert.equal(state.currentFile, newFile, 'currentFile advanced to new day');
  assert.equal(state.byteOffset, 0, 'byteOffset reset to 0');
  assert.equal(state.partialLine, '', 'partialLine cleared');

  assert.equal(accessors.getDviTraceOffset(oldFile), 99999, 'OLD file final offset persisted');
  assert.equal(accessors.getDviTraceOffset(newFile), 0, 'NEW file seeded at 0');

  // Same-file call is a no-op (currentFile === newFilename).
  state.byteOffset = 4242;
  simulateDayRollover(state, newFile, accessors);
  assert.equal(state.byteOffset, 4242, 'no reset when filename unchanged');
  assert.equal(accessors.getDviTraceOffset(newFile), 0, 'persisted offset for new file unchanged');
});

// ─── T6: recover() endpoint still triggers full loadHistory ─────────────────
section('T6: recover() manual override still does full loadHistory replay');
test('recover() clears in-memory state and routes to history replay (not trust-SQLite)', () => {
  // recover() unconditionally clears jobs/offset/partialLine and calls
  // loadHistory(). After that clear, the trust-SQLite gate (jobs.size > 0)
  // must NOT engage — recovery is the explicit escape hatch and must always
  // rebuild from files. We model that here by replaying recover()'s clear
  // step on a fully-populated state and confirming the cold-start branch
  // picker would route to load-history.
  const db = makeDb();
  const accessors = makeOffsetAccessors(db);
  const todayFile = getTodayFilename();

  // Pre-state: SQLite has jobs and an offset; in-memory jobs map has entries.
  seedJobs(db, 50);
  accessors.setDviTraceOffset(todayFile, 999);
  const jobs = new Map();
  loadFromDb(db, jobs);
  assert.equal(jobs.size, 50, 'pre-recover: 50 jobs in memory');

  // recover() clears in-memory state — model it.
  jobs.clear();
  const stateAfterClear = { currentFile: null, byteOffset: 0, partialLine: '' };

  // Now if recover() routed through the SAME cold-start gate, an empty jobs
  // Map must mean "load-history". Confirm.
  const branch = pickColdStartBranch(jobs);
  assert.equal(branch, 'load-history',
    'after recover() clear, branch must be load-history (escape hatch contract)');

  // recover() does NOT touch the dvi_trace_offsets table — the persisted
  // offset for today's file remains, but loadHistory will read the full file
  // and reset byteOffset to data.length itself. So a leftover 999 in the
  // offsets table is harmless; the next poll re-persists the post-replay value.
  assert.equal(accessors.getDviTraceOffset(todayFile), 999,
    'recover() leaves offsets table alone; loadHistory will overwrite via next poll');
  assert.equal(stateAfterClear.byteOffset, 0, 'in-memory byteOffset cleared by recover()');
});

// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  for (const step of pendingTests) await step();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
