#!/usr/bin/env node
// Historical dedup for job_events and stage_transitions via TABLE REBUILD.
//
// Approach:
//   1. snapshot MAX(rowid)
//   2. CREATE TABLE x_new (same schema, no indexes yet)
//   3. INSERT x_new SELECT * FROM x WHERE rowid <= snap AND rowid IN (MIN per natural key)
//   4. INSERT x_new SELECT * FROM x WHERE rowid > snap   (catches live writes)
//   5. atomic swap: rename old→_old, _new→original, recreate indexes
//   6. DROP TABLE x_old
//   7. PRAGMA wal_checkpoint(TRUNCATE)
//
// Why faster than chunked DELETE:
//   - INSERT into empty table + bulk index build is ~50x faster than DELETE
//     with index updates per row.
//   - One single GROUP BY scan instead of 365 daily ones.
//
// Live writes during rebuild are preserved via the rowid > snapshot catchup.
// Brief SQLITE_BUSY during the swap (sub-second); better-sqlite3 retries.
//
// Logging: writes to /tmp/dedup.log via fs.appendFileSync so output is
// guaranteed unbuffered (Node's stdout block-buffers when piped).
//
// Usage:
//   node scripts/dedup-trace-tables.js [/path/to/lab_assistant.db]

const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = process.argv[2] || '/Users/Shared/lab_assistant/data/lab_assistant.db';
const LOG_PATH = '/tmp/dedup.log';

function log(s) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}\n`;
  fs.appendFileSync(LOG_PATH, line);
  process.stdout.write(line);
}

const db = new Database(DB_PATH);
log(`Opened ${DB_PATH}`);
log(`journal_mode=${db.pragma('journal_mode', { simple: true })}`);

function rebuildTable(table, key) {
  log(`\n[${table}] === STARTING ===`);
  const t0 = Date.now();

  // Get table schema
  const tblRow = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  if (!tblRow) {
    log(`[${table}] table not found, skipping`);
    return;
  }
  const tableSql = tblRow.sql;

  // Get all index DDL for the table (skip auto-indexes which have NULL sql)
  const indexes = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
  ).all(table);
  log(`[${table}] found ${indexes.length} indexes to recreate`);

  // Snapshot current MAX(rowid) before any work — anything > this is a live write
  const snap = db.prepare(`SELECT MAX(rowid) AS max_rowid, COUNT(*) AS count FROM ${table}`).get();
  log(`[${table}] snapshot: rowid<=${snap.max_rowid}, count=${snap.count}`);
  if (!snap.max_rowid) {
    log(`[${table}] empty table, skipping`);
    return;
  }

  // Clean any partial _new from a previous interrupted run
  db.exec(`DROP TABLE IF EXISTS ${table}_new`);

  // Create _new with same schema (rename CREATE TABLE in the DDL string)
  const newDdl = tableSql.replace(
    new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["\`]?${table}["\`]?`, 'i'),
    `CREATE TABLE ${table}_new`
  );
  db.exec(newDdl);
  log(`[${table}] _new table created`);

  // Phase 1: copy unique rows up to snapshot
  log(`[${table}] Phase 1: scanning + copying unique rows (the slow part — patience)...`);
  const t1 = Date.now();
  const r1 = db.prepare(`
    INSERT INTO ${table}_new
    SELECT * FROM ${table}
    WHERE rowid <= @snap
      AND rowid IN (
        SELECT MIN(rowid) FROM ${table}
        WHERE rowid <= @snap
        GROUP BY ${key.join(', ')}
      )
  `).run({ snap: snap.max_rowid });
  const t1sec = ((Date.now() - t1) / 1000).toFixed(1);
  log(`[${table}]   copied ${r1.changes} unique rows in ${t1sec}s`);

  // Phase 2: catch live writes that came in during phase 1
  log(`[${table}] Phase 2: catching live writes since snapshot...`);
  const r2 = db.prepare(`
    INSERT INTO ${table}_new
    SELECT * FROM ${table} WHERE rowid > ?
  `).run(snap.max_rowid);
  log(`[${table}]   caught ${r2.changes} live writes (these are not deduped — fresh data)`);

  // Phase 3: atomic swap + recreate indexes
  log(`[${table}] Phase 3: atomic swap + index rebuild...`);
  const t3 = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    for (const ix of indexes) db.exec(ix.sql);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    log(`[${table}] SWAP FAILED: ${e.message}`);
    throw e;
  }
  log(`[${table}]   swapped in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  // Phase 4: drop old table (releases pages to freelist; doesn't shrink file)
  log(`[${table}] Phase 4: dropping old table...`);
  db.exec(`DROP TABLE ${table}_old`);
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();

  const finalCount = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[${table}] === DONE in ${totalSec}s ===`);
  log(`[${table}]   before: ${snap.count} rows`);
  log(`[${table}]   after:  ${finalCount} rows`);
  log(`[${table}]   removed: ${snap.count - finalCount} duplicates (${((1 - finalCount/snap.count) * 100).toFixed(1)}%)`);
}

try {
  // Truncate log on each run
  fs.writeFileSync(LOG_PATH, '');

  rebuildTable('job_events',        ['invoice', 'station', 'event_ts']);
  rebuildTable('stage_transitions', ['job_id', 'transition_at', 'from_stage', 'to_stage']);

  log('\nAll done.');
  log('Disk file size has NOT shrunk yet — pages went to the freelist.');
  log('Run VACUUM (separately, with disk headroom) to actually reclaim disk.');
} catch (e) {
  log(`ERROR: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
