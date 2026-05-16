#!/usr/bin/env node
// Phil 2026-05-15 — backfill historical dept-actual columns using the
// corrected exit-event definitions:
//
//   coating  → invoices touching station='RECEIVED COAT' that day
//   surfacing → invoices touching station='SENT TO COAT' that day
//   cutting  → invoices whose FIRST ASSEMBLY-stage event is that day
//
// Affects:
//   daily_coating_targets.coated_actual (+ variance + rate cols)
//   daily_surfacing_targets.surfaced_actual (+ variance + rate cols)
//   daily_dept_actuals (dept='cutting' / 'assembly' / 'surfacing')
//
// Two-phase: dry run → --apply.
//
//   node scripts/backfill-dept-actuals-history.js
//   node scripts/backfill-dept-actuals-history.js --apply
//
// Idempotent. Safe to re-run.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LAB_DB || path.join(__dirname, '..', 'data', 'lab_assistant.db');
const APPLY   = process.argv.includes('--apply');
const SHIFT_HOURS = 16; // matches captureRateMetrics on finalized rows

console.log('━'.repeat(72));
console.log(`Backfill dept-actual history with corrected exit-event definitions`);
console.log(`db: ${DB_PATH}`);
console.log(`mode: ${APPLY ? 'APPLY (writes will happen)' : 'DRY RUN (read-only)'}`);
console.log('━'.repeat(72));

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('journal_mode = WAL');

function rateMetrics(actual, target) {
  const ratePerHour = Math.round(((actual || 0) / SHIFT_HOURS) * 10) / 10;
  const ratePct = (target && target > 0)
    ? Math.min(999, Math.round(((actual || 0) / target) * 1000) / 10)
    : 0;
  return { ratePerHour, ratePct };
}

// ─── coating: invoices touching station='RECEIVED COAT' that day ─────
const coatingRows = db.prepare(`
  SELECT date, total_target, coated_actual FROM daily_coating_targets
`).all();
const coatingExitStmt = db.prepare(`
  SELECT COUNT(DISTINCT invoice) AS n
  FROM job_events
  WHERE station = 'RECEIVED COAT'
    AND date(event_ts/1000,'unixepoch','localtime') = ?
`);
const coatingChanges = [];
for (const r of coatingRows) {
  const newActual = coatingExitStmt.get(r.date)?.n || 0;
  if (newActual !== r.coated_actual) {
    coatingChanges.push({ ...r, newActual, delta: newActual - r.coated_actual });
  }
}

// ─── surfacing: invoices touching station='SENT TO COAT' that day ────
const surfacingRows = db.prepare(`
  SELECT date, total_target, surfaced_actual FROM daily_surfacing_targets
`).all();
const surfacingExitStmt = db.prepare(`
  SELECT COUNT(DISTINCT invoice) AS n
  FROM job_events
  WHERE station = 'SENT TO COAT'
    AND date(event_ts/1000,'unixepoch','localtime') = ?
`);
const surfacingChanges = [];
for (const r of surfacingRows) {
  const newActual = surfacingExitStmt.get(r.date)?.n || 0;
  if (newActual !== r.surfaced_actual) {
    surfacingChanges.push({ ...r, newActual, delta: newActual - r.surfaced_actual });
  }
}

// ─── cutting: invoices whose FIRST ASSEMBLY-stage event is that day ──
const cuttingRows = db.prepare(`
  SELECT date, target, actual FROM daily_dept_actuals WHERE dept = 'cutting'
`).all();
const cuttingExitStmt = db.prepare(`
  WITH first_assembly AS (
    SELECT invoice, MIN(event_ts) AS first_ts
    FROM job_events WHERE stage = 'ASSEMBLY'
    GROUP BY invoice
  )
  SELECT COUNT(*) AS n FROM first_assembly
  WHERE date(first_ts/1000,'unixepoch','localtime') = ?
`);
const cuttingChanges = [];
for (const r of cuttingRows) {
  const newActual = cuttingExitStmt.get(r.date)?.n || 0;
  if (newActual !== r.actual) {
    cuttingChanges.push({ ...r, newActual, delta: newActual - r.actual });
  }
}

// ─── report ───
const fmt = (n) => (n >= 0 ? '+' : '') + n;
const summarize = (label, changes) => {
  if (!changes.length) {
    console.log(`\n${label}: nothing to backfill (all rows already correct)`);
    return;
  }
  const upDelta = changes.filter(c => c.delta > 0).length;
  const downDelta = changes.filter(c => c.delta < 0).length;
  const totalDelta = changes.reduce((s, c) => s + c.delta, 0);
  console.log(`\n${label}: ${changes.length} rows changed (${upDelta} up, ${downDelta} down, net ${fmt(totalDelta)})`);
  // Sample first 5 + last 5
  const sample = [...changes.slice(0, 5), ...(changes.length > 10 ? changes.slice(-5) : [])];
  for (const c of sample) {
    console.log(`  ${c.date}  was=${c.coated_actual ?? c.surfaced_actual ?? c.actual} → now=${c.newActual} (${fmt(c.delta)})`);
  }
};

summarize('COATING (RECEIVED COAT events)', coatingChanges);
summarize('SURFACING (SENT TO COAT events)', surfacingChanges);
summarize('CUTTING (first ASSEMBLY event)', cuttingChanges);

const totalChanges = coatingChanges.length + surfacingChanges.length + cuttingChanges.length;
if (totalChanges === 0) {
  console.log('\nAll rows already match new definitions. Nothing to do.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY RUN complete. Re-run with --apply to write the changes.');
  process.exit(0);
}

console.log('\nApplying...');
const updCoating = db.prepare(`
  UPDATE daily_coating_targets
  SET coated_actual = ?, variance = ? - total_target,
      rate_per_hour = ?, rate_vs_goal_pct = ?
  WHERE date = ?
`);
const updSurfacing = db.prepare(`
  UPDATE daily_surfacing_targets
  SET surfaced_actual = ?, variance = ? - total_target,
      rate_per_hour = ?, rate_vs_goal_pct = ?
  WHERE date = ?
`);
const updCutting = db.prepare(`
  UPDATE daily_dept_actuals
  SET actual = ?, rate_per_hour = ?, rate_vs_goal_pct = ?
  WHERE date = ? AND dept = 'cutting'
`);

const tx = db.transaction(() => {
  for (const c of coatingChanges) {
    const m = rateMetrics(c.newActual, c.total_target);
    updCoating.run(c.newActual, c.newActual, m.ratePerHour, m.ratePct, c.date);
  }
  for (const c of surfacingChanges) {
    const m = rateMetrics(c.newActual, c.total_target);
    updSurfacing.run(c.newActual, c.newActual, m.ratePerHour, m.ratePct, c.date);
  }
  for (const c of cuttingChanges) {
    const m = rateMetrics(c.newActual, c.target);
    updCutting.run(c.newActual, m.ratePerHour, m.ratePct, c.date);
  }
});
tx();

console.log(`✅ Updated: coating=${coatingChanges.length}, surfacing=${surfacingChanges.length}, cutting=${cuttingChanges.length}`);
console.log('Hard-refresh SPA — dept GoalHistory tables retroactively show real numbers.');
