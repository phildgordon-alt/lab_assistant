#!/usr/bin/env node
'use strict';

/**
 * Backfill — Surfacing daily actuals from job_events history.
 *
 * Surfacing was added as a tracked dept on 2026-05-13. Before that day
 * no rows exist in daily_dept_actuals for dept='surfacing', so the
 * Surfacing tab's GoalHistory table shows only today's row, which
 * visually echoes the GoalBar above it (Phil flagged this as a
 * "doubled up" duplicate on 2026-05-13).
 *
 * This script computes the "last SURFACING event on day X" count for
 * each past day in the window and UPSERTs into daily_dept_actuals so
 * GoalHistory has multi-day context for the Surfacing tab.
 *
 * The count rule matches countSurfacingExitsToday in domain/daily-
 * capture.js (post-Phil-redefinition 2026-05-13): distinct invoices
 * where MAX(event_ts WHERE stage='SURFACING') falls in the day.
 *
 * Idempotent. UPSERT semantics — re-running just refreshes the rows.
 *
 * Usage:
 *   node scripts/backfill-surfacing-actuals.js              # dry-run, 30d window
 *   node scripts/backfill-surfacing-actuals.js --days 60    # dry-run, 60d window
 *   node scripts/backfill-surfacing-actuals.js --apply      # write rows
 *   node scripts/backfill-surfacing-actuals.js --apply --days 60
 */

const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const daysIdx = argv.indexOf('--days');
const DAYS = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) || 30 : 30;

const DB_PATH = process.env.LAB_DB_PATH
  || path.join(__dirname, '..', 'data', 'lab_assistant.db');

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('journal_mode = WAL');

console.log(`backfill-surfacing-actuals`);
console.log(`  DB:     ${DB_PATH}`);
console.log(`  window: last ${DAYS} days`);
console.log(`  mode:   ${APPLY ? 'APPLY (writes daily_dept_actuals)' : 'DRY-RUN'}`);
console.log('');

// Per-day distinct-invoice count where MAX(stage='SURFACING' event_ts)
// falls in the day's PT-local window. Same shape as countSurfacingExits-
// Today, broadcast across a date range.
const rows = db.prepare(`
  WITH last_surfacing AS (
    SELECT invoice, MAX(event_ts) AS last_ts
    FROM job_events
    WHERE stage = 'SURFACING'
    GROUP BY invoice
  )
  SELECT date(last_ts/1000, 'unixepoch', 'localtime') AS d,
         COUNT(*) AS actual
  FROM last_surfacing
  WHERE date(last_ts/1000, 'unixepoch', 'localtime')
        >= date('now', 'localtime', '-' || ? || ' days')
    AND date(last_ts/1000, 'unixepoch', 'localtime')
        <  date('now', 'localtime', '+1 day')
  GROUP BY d
  ORDER BY d ASC
`).all(DAYS);

if (rows.length === 0) {
  console.log('No surfacing events found in window — nothing to backfill.');
  process.exit(0);
}

console.log(`Found surfacing exits across ${rows.length} day(s):`);
console.log(`  earliest: ${rows[0].d} (${rows[0].actual})`);
console.log(`  latest:   ${rows[rows.length - 1].d} (${rows[rows.length - 1].actual})`);
console.log(`  total:    ${rows.reduce((s, r) => s + r.actual, 0)} invoice-day exits`);
console.log('');

// Existing rows for the same dates — show what would change.
const existing = db.prepare(`
  SELECT date, actual FROM daily_dept_actuals
  WHERE dept = 'surfacing' AND date >= date('now', 'localtime', '-' || ? || ' days')
`).all(DAYS);
const existingMap = new Map(existing.map(r => [r.date, r.actual]));

const inserts = [];
const updates = [];
const unchanged = [];
for (const r of rows) {
  if (!existingMap.has(r.d))     inserts.push(r);
  else if (existingMap.get(r.d) !== r.actual) updates.push({ ...r, old: existingMap.get(r.d) });
  else                          unchanged.push(r);
}

console.log(`Plan:`);
console.log(`  ${inserts.length} INSERT  (new rows)`);
console.log(`  ${updates.length} UPDATE  (existing rows with different actual)`);
console.log(`  ${unchanged.length} UNCHANGED (already correct)`);
console.log('');

if (inserts.length || updates.length) {
  console.log('Sample of changes:');
  const sample = [...inserts.slice(0, 5).map(r => ({ ...r, op: 'INSERT' })),
                  ...updates.slice(0, 5).map(r => ({ ...r, op: 'UPDATE' }))];
  for (const s of sample) {
    if (s.op === 'INSERT') console.log(`  ${s.d}  INSERT  actual=${s.actual}`);
    else                   console.log(`  ${s.d}  UPDATE  ${s.old} → ${s.actual}`);
  }
  console.log('');
}

if (!APPLY) {
  console.log('Dry-run complete. Re-run with --apply to write the rows.');
  process.exit(0);
}

// APPLY
const upsert = db.prepare(`
  INSERT INTO daily_dept_actuals (date, dept, actual)
  VALUES (?, 'surfacing', ?)
  ON CONFLICT(date, dept) DO UPDATE SET actual = excluded.actual,
                                        captured_at = datetime('now')
`);
const tx = db.transaction((rs) => {
  for (const r of rs) upsert.run(r.d, r.actual);
});
tx(rows);

console.log(`Wrote ${inserts.length + updates.length} row(s) to daily_dept_actuals.`);
console.log('Done.');
