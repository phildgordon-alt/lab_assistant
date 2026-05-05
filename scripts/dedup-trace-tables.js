#!/usr/bin/env node
// One-shot historical dedup for job_events and stage_transitions.
//
// Background: the live writers in dvi-trace.js (job_events) and time-at-lab.js
// (stage_transitions) re-read the same TRACE lines repeatedly via SMB tail,
// producing ~1000x duplicate rows. After 12 months: ~555M rows in each table
// where the actual unique-event count is closer to 250K. The 2026-05-05 writer
// patches add WHERE NOT EXISTS guards so future writes can't dupe; this script
// cleans up the historical pile.
//
// Safe to re-run. Chunks by day (event_ts / transition_at) so WAL stays
// bounded. Checkpoints WAL every chunk. Logs progress.
//
// Usage:
//   node scripts/dedup-trace-tables.js [/path/to/lab_assistant.db]
//
// Default DB path: /Users/Shared/lab_assistant/data/lab_assistant.db (prod).

const Database = require('better-sqlite3');

const DB_PATH = process.argv[2] || '/Users/Shared/lab_assistant/data/lab_assistant.db';
const DAY_MS = 24 * 60 * 60 * 1000;

const db = new Database(DB_PATH);
console.log(`[dedup] Opened ${DB_PATH}`);
console.log(`[dedup] journal_mode=${db.pragma('journal_mode', { simple: true })}`);

function dedupTable(table, key, tsCol) {
  console.log(`\n[${table}] starting; key=(${key.join(',')}), tsCol=${tsCol}`);

  const range = db.prepare(
    `SELECT MIN(${tsCol}) AS min_ts, MAX(${tsCol}) AS max_ts, COUNT(*) AS total FROM ${table}`
  ).get();
  console.log(`[${table}] before: total=${range.total}, range=${range.min_ts}..${range.max_ts}`);

  if (!range.min_ts || !range.max_ts) {
    console.log(`[${table}] empty or no timestamps — skipping`);
    return;
  }

  const dedupChunk = db.prepare(`
    DELETE FROM ${table}
    WHERE ${tsCol} >= ? AND ${tsCol} < ?
      AND id NOT IN (
        SELECT MIN(id) FROM ${table}
        WHERE ${tsCol} >= ? AND ${tsCol} < ?
        GROUP BY ${key.join(', ')}
      )
  `);
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)');

  let totalDeleted = 0;
  let chunkStart = range.min_ts;
  let chunksProcessed = 0;
  const startedAt = Date.now();

  while (chunkStart < range.max_ts) {
    const chunkEnd = chunkStart + DAY_MS;
    const t0 = Date.now();
    const result = dedupChunk.run(chunkStart, chunkEnd, chunkStart, chunkEnd);
    const elapsed = Date.now() - t0;
    chunksProcessed++;

    if (result.changes > 0) {
      totalDeleted += result.changes;
      const isoFrom = new Date(chunkStart).toISOString().slice(0, 10);
      console.log(`[${table}] ${isoFrom}: -${result.changes} dupes (${elapsed}ms, total -${totalDeleted})`);
    }

    // Checkpoint every 7 chunks so WAL doesn't blow disk
    if (chunksProcessed % 7 === 0) {
      checkpoint.run();
    }

    chunkStart = chunkEnd;
  }

  checkpoint.run();
  const after = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  const wallSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${table}] DONE: deleted ${totalDeleted}, remaining ${after.total} (${wallSec}s wall)`);
}

try {
  dedupTable('job_events',         ['invoice', 'station', 'event_ts'],            'event_ts');
  dedupTable('stage_transitions',  ['job_id', 'transition_at', 'from_stage', 'to_stage'], 'transition_at');

  console.log('\n[dedup] All done.');
  console.log('[dedup] File size will not shrink until you VACUUM.');
  console.log('[dedup] VACUUM needs free disk >= current DB size — see next step.');
} catch (e) {
  console.error(`[dedup] ERROR: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
