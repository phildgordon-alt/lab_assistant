#!/usr/bin/env node
// Phil 2026-05-15 — backfill rate_per_hour + rate_vs_goal_pct on historical
// dept-target rows. Migration 020 added the columns today; daily-capture
// only populates rows it's writing going forward, so the 7d/30d analytics
// averages start at 0 samples until enough days accumulate.
//
// Backfill assumes 16h full workday (5 AM - 9 PM PT, two shifts) for
// FINALIZED rows (full day complete). Skips today / non-finalized rows
// since those are being live-updated by the hourly cron.
//
// Usage: node scripts/backfill-dept-rate-history.js
// Idempotent — only updates rows where rate_per_hour IS NULL.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LAB_DB || path.join(__dirname, '..', 'data', 'lab_assistant.db');
const SHIFT_HOURS = 16;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const TABLES = [
  { table: 'daily_ship_targets',      actualCol: 'shipped_actual',   targetCol: 'total_target' },
  { table: 'daily_coating_targets',   actualCol: 'coated_actual',    targetCol: 'total_target' },
  { table: 'daily_surfacing_targets', actualCol: 'surfaced_actual',  targetCol: 'total_target' },
  { table: 'daily_picking_targets',   actualCol: 'picked_actual',    targetCol: 'total_target' },
];

console.log('━'.repeat(72));
console.log(`Backfill dept-rate history → ${DB_PATH}`);
console.log(`Assuming SHIFT_HOURS=${SHIFT_HOURS} for finalized rows`);
console.log('━'.repeat(72));

let totalUpdated = 0;
const tx = db.transaction(() => {
  for (const t of TABLES) {
    try {
      const r = db.prepare(`
        UPDATE ${t.table}
        SET rate_per_hour = ROUND(CAST(${t.actualCol} AS REAL) / ${SHIFT_HOURS} * 10) / 10,
            rate_vs_goal_pct = CASE
              WHEN ${t.targetCol} > 0
              THEN MIN(999, ROUND(CAST(${t.actualCol} AS REAL) * 1000 / ${t.targetCol}) / 10.0)
              ELSE 0 END
        WHERE rate_per_hour IS NULL
          AND finalized_at IS NOT NULL
      `).run();
      console.log(`  ${t.table.padEnd(28)} → ${r.changes} rows updated`);
      totalUpdated += r.changes;
    } catch (e) {
      console.log(`  ${t.table.padEnd(28)} → SKIPPED (${e.message})`);
    }
  }

  // daily_dept_actuals — cutting + assembly. target column was also added
  // in migration 020 but historical rows have NULL target. Skip rows where
  // target is null (can't compute rate_vs_goal). Still backfill rate_per_hour.
  try {
    const r1 = db.prepare(`
      UPDATE daily_dept_actuals
      SET rate_per_hour = ROUND(CAST(actual AS REAL) / ${SHIFT_HOURS} * 10) / 10
      WHERE rate_per_hour IS NULL
        AND finalized_at IS NOT NULL
    `).run();
    console.log(`  daily_dept_actuals (rate)   → ${r1.changes} rows updated`);
    totalUpdated += r1.changes;
    const r2 = db.prepare(`
      UPDATE daily_dept_actuals
      SET rate_vs_goal_pct = MIN(999, ROUND(CAST(actual AS REAL) * 1000 / target) / 10.0)
      WHERE rate_vs_goal_pct IS NULL
        AND finalized_at IS NOT NULL
        AND target IS NOT NULL AND target > 0
    `).run();
    console.log(`  daily_dept_actuals (pct)    → ${r2.changes} rows updated`);
    totalUpdated += r2.changes;
  } catch (e) {
    console.log(`  daily_dept_actuals          → SKIPPED (${e.message})`);
  }
});
tx();

console.log('━'.repeat(72));
console.log(`Total: ${totalUpdated} rows backfilled.`);
console.log(`Verify: hit /api/analytics/dept-rates and check avgShort.samples > 0.`);
