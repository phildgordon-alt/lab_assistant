#!/usr/bin/env node
'use strict';

/**
 * Faithful WIP-replay backfill — daily_ship_targets / daily_coating_targets
 * / daily_surfacing_targets.
 *
 * Phil 2026-05-13: the live capture writers had two structural bugs that
 * left history wrong:
 *
 *   1. captureDailyShipTarget wrote legacy v1 numbers (svWip*0.5 +
 *      surfWip*0.33) to total_target while /api/shipping/dashboard
 *      returned v2 (priority-weighted from computeShipTarget). Past rows
 *      in daily_ship_targets show v1, GoalHistory rendered v1, dashboard
 *      never showed v1. Disagreement is silent.
 *
 *   2. daily_surfacing_targets didn't exist until migration 013 today.
 *      Past surfacing targets are simply absent — GoalHistory on the
 *      Surfacing tab shows only today.
 *
 *   3. captureDailyCoatingTarget exists but only goes back to whenever
 *      it first ran. Earlier days have no daily_coating_targets row.
 *
 * Fix: walk job_events day-by-day, reconstruct end-of-day WIP for each
 * historical workday, call the same compute* functions the live writer
 * uses (now with options.wipSnapshot injection), UPSERT.
 *
 * Idempotent: rows where finalized_at IS NOT NULL OR formula_version=2
 * (already correctly captured by the new writer) are SKIPPED unless
 * --force is passed.
 *
 * Order: walks workdays FORWARD chronologically because the rollover
 * term reads prior workdays this week. Tuesday's backfill needs
 * Monday's row already written.
 *
 * Usage:
 *   node scripts/backfill-dept-targets.js                  # dry-run, 30d
 *   node scripts/backfill-dept-targets.js --days 90        # dry-run, 90d
 *   node scripts/backfill-dept-targets.js --apply          # write
 *   node scripts/backfill-dept-targets.js --apply --days 90
 *   node scripts/backfill-dept-targets.js --apply --force  # overwrite
 *                                                            finalized rows too
 *   node scripts/backfill-dept-targets.js --depts ship,coating,surfacing  # subset
 */

const path = require('path');
const Database = require('better-sqlite3');

// ─────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APPLY  = argv.includes('--apply');
const FORCE  = argv.includes('--force');
const VERBOSE = argv.includes('--verbose');
const daysIdx = argv.indexOf('--days');
const DAYS = daysIdx >= 0 ? Math.max(1, parseInt(argv[daysIdx + 1], 10) || 30) : 30;
const deptsIdx = argv.indexOf('--depts');
const DEPTS_ARG = deptsIdx >= 0 ? argv[deptsIdx + 1] : 'ship,coating,surfacing';
const DEPTS = new Set(DEPTS_ARG.split(',').map(s => s.trim().toLowerCase()));

const DB_PATH = process.env.LAB_DB_PATH
  || path.join(__dirname, '..', 'data', 'lab_assistant.db');

// ─────────────────────────────────────────────────────────────────────
// Date helpers (mirror the domain modules)
// ─────────────────────────────────────────────────────────────────────

function ymdToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function priorWorkday(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
function isWorkday(ymd) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return dow !== 0 && dow !== 6;
}
function nextDayYMD(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * EOD timestamp for a PT-local date (YYYY-MM-DD), in unix ms.
 * 23:59:59.999 PT → unix ms. PT is UTC-7 (PDT) for May; close enough
 * for ±1-hour DST drift, which is harmless within a workday boundary.
 */
function eodMs(ymd) {
  return new Date(ymd + 'T23:59:59.999-07:00').getTime();
}

// ─────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('journal_mode = WAL');

// Apply any pending migrations BEFORE we touch tables (the script depends
// on migration 014's `backfilled` column existing). On prod the server's
// own boot runMigrations call has already applied them, but a standalone
// script run against a fresh DB needs this safety net. Read-only mode
// blocks DDL, so only run if --apply.
if (APPLY) {
  try {
    const { runMigrations } = require('../server/migration-runner');
    runMigrations(db, { log: (s) => console.log(`  [migrations] ${s}`) });
  } catch (e) {
    console.warn(`  [migrations] runner unavailable in this checkout (${e.code || e.message}). Continuing — required columns must already exist.`);
  }
}

// Probe required columns; if missing, exit early with a clear message
// instead of a cryptic SQLite error mid-loop.
function hasColumn(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}
const required = [
  ['daily_ship_targets',      'backfilled'],
  ['daily_coating_targets',   'backfilled'],
  ['daily_surfacing_targets', 'backfilled'],
];
const missing = required.filter(([t, c]) => {
  try { return !hasColumn(t, c); }
  catch (_) { return true; } // table doesn't exist either
});
if (missing.length) {
  console.error(`Missing columns/tables: ${missing.map(([t,c]) => `${t}.${c}`).join(', ')}`);
  console.error(`Migrations 013 and 014 must be applied first. Run the server (which auto-applies) or apply manually.`);
  process.exit(2);
}

console.log('backfill-dept-targets');
console.log(`  DB:      ${DB_PATH}`);
console.log(`  window:  last ${DAYS} workdays`);
console.log(`  depts:   ${[...DEPTS].join(', ')}`);
console.log(`  mode:    ${APPLY ? 'APPLY (writes target tables)' : 'DRY-RUN'}${FORCE ? ' [--force: overwrites finalized + v2 rows]' : ''}`);
console.log('');

// Domain modules (load after DB exists so they can read config)
const { computeShipTarget }      = require('../server/domain/ship-target');
const { computeCoatingTarget }   = require('../server/domain/coating-target');
const { computeSurfacingTarget } = require('../server/domain/surfacing-target');
const { classify } = require('../server/domain/lens-classifier');

// ─────────────────────────────────────────────────────────────────────
// EOD WIP reconstruction
// ─────────────────────────────────────────────────────────────────────

/**
 * For each invoice with any job_events row before EOD `ymd`, find:
 *  - first_ts (entry into the lab)
 *  - last_stage (most recent stage event at or before EOD)
 * Return WIP rows for invoices whose last_stage is not terminal AND
 * whose ship_date (if known) is after `ymd`.
 *
 * This is the "what was in flight at end of day D" set. We then derive:
 *  - activeWIP = all such rows
 *  - coatingWIP = subset WHERE last_stage='COATING'
 *  - surfacingWIP = subset WHERE last_stage='SURFACING'
 */
const wipQuery = db.prepare(`
  WITH inv_min AS (
    SELECT invoice, MIN(event_ts) AS first_ts
    FROM job_events
    WHERE event_ts <= ?
    GROUP BY invoice
  ),
  inv_last AS (
    SELECT je.invoice, je.stage AS last_stage, je.event_ts AS last_ts
    FROM job_events je
    JOIN (
      SELECT invoice, MAX(event_ts) AS max_ts
      FROM job_events
      WHERE event_ts <= ?
      GROUP BY invoice
    ) m ON m.invoice = je.invoice AND m.max_ts = je.event_ts
  )
  SELECT j.invoice,
         j.lens_type,
         date(im.first_ts/1000, 'unixepoch', 'localtime') AS entry_ymd,
         il.last_stage AS current_stage,
         j.status
  FROM jobs j
  JOIN inv_min  im ON im.invoice = j.invoice
  JOIN inv_last il ON il.invoice = j.invoice
  WHERE il.last_stage NOT IN ('CANCELED','SHIPPED','COMPLETE','HOLD')
    AND (j.ship_date IS NULL OR j.ship_date = '' OR j.ship_date > ?)
`);

function reconstructWIP(ymd) {
  const eod = eodMs(ymd);
  const allWip = wipQuery.all(eod, eod, ymd);
  return {
    active:    allWip,
    coating:   allWip.filter(r => r.current_stage === 'COATING'),
    surfacing: allWip.filter(r => r.current_stage === 'SURFACING'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-day count queries (deterministic — pull from job_events directly)
// ─────────────────────────────────────────────────────────────────────

function countShippedOnDay(ymd) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM dvi_shipped_jobs
    WHERE is_hko = 0 AND ship_date = ?
  `).get(ymd);
  return row?.n || 0;
}

const countLastStageOnDay = (stage) => db.prepare(`
  WITH last_st AS (
    SELECT invoice, MAX(event_ts) AS last_ts
    FROM job_events
    WHERE stage = ?
    GROUP BY invoice
  )
  SELECT COUNT(*) AS n
  FROM last_st
  WHERE date(last_ts/1000, 'unixepoch', 'localtime') = ?
`);
const lastStageStmt = countLastStageOnDay();

function countStageExitsOnDay(stage, ymd) {
  return db.prepare(`
    WITH last_st AS (
      SELECT invoice, MAX(event_ts) AS last_ts
      FROM job_events
      WHERE stage = ?
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM last_st
    WHERE date(last_ts/1000, 'unixepoch', 'localtime') = ?
  `).get(stage, ymd)?.n || 0;
}

// ─────────────────────────────────────────────────────────────────────
// Per-day backfill — one transaction per day so rollover reads see
// committed prior-day rows even within the same script run
// ─────────────────────────────────────────────────────────────────────

const upsertShip = db.prepare(`
  INSERT INTO daily_ship_targets
    (date, is_workday,
     sv_wip, surf_wip, unknown_wip,
     sv_target, surf_target,
     total_target, shipped_actual, variance, variance_pct,
     aged_wip, fresh_wip,
     priority_weighted, intake_projection, capacity_estimate,
     rollover_in, operational_target, sla_floor, gap,
     formula_version, backfilled)
  VALUES (?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          2, 1)
  ON CONFLICT(date) DO UPDATE SET
    is_workday = excluded.is_workday,
    sv_wip = excluded.sv_wip, surf_wip = excluded.surf_wip, unknown_wip = excluded.unknown_wip,
    sv_target = excluded.sv_target, surf_target = excluded.surf_target,
    total_target = excluded.total_target, shipped_actual = excluded.shipped_actual,
    variance = excluded.variance, variance_pct = excluded.variance_pct,
    aged_wip = excluded.aged_wip, fresh_wip = excluded.fresh_wip,
    priority_weighted = excluded.priority_weighted,
    intake_projection = excluded.intake_projection,
    capacity_estimate = excluded.capacity_estimate,
    rollover_in = excluded.rollover_in,
    operational_target = excluded.operational_target,
    sla_floor = excluded.sla_floor, gap = excluded.gap,
    formula_version = 2,
    backfilled = 1
`);

const upsertCoating = db.prepare(`
  INSERT INTO daily_coating_targets
    (date, is_workday, coating_wip, intake_projection, capacity_estimate,
     rollover_in, total_target, coated_actual, variance,
     formula_version, backfilled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  ON CONFLICT(date) DO UPDATE SET
    is_workday = excluded.is_workday,
    coating_wip = excluded.coating_wip,
    intake_projection = excluded.intake_projection,
    capacity_estimate = excluded.capacity_estimate,
    rollover_in = excluded.rollover_in,
    total_target = excluded.total_target,
    coated_actual = excluded.coated_actual,
    variance = excluded.variance,
    backfilled = 1
`);

const upsertSurfacing = db.prepare(`
  INSERT INTO daily_surfacing_targets
    (date, is_workday, surfacing_wip, intake_projection, capacity_estimate,
     rollover_in, total_target, surfaced_actual, variance,
     formula_version, backfilled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  ON CONFLICT(date) DO UPDATE SET
    is_workday = excluded.is_workday,
    surfacing_wip = excluded.surfacing_wip,
    intake_projection = excluded.intake_projection,
    capacity_estimate = excluded.capacity_estimate,
    rollover_in = excluded.rollover_in,
    total_target = excluded.total_target,
    surfaced_actual = excluded.surfaced_actual,
    variance = excluded.variance,
    backfilled = 1
`);

function shouldSkip(table, ymd) {
  if (FORCE) return false;
  const row = db.prepare(`SELECT finalized_at, formula_version FROM ${table} WHERE date = ?`).get(ymd);
  if (!row) return false; // doesn't exist → don't skip
  if (row.finalized_at) return { reason: 'finalized' };
  // For ship: a v2 capture is correct, leave it. For coating/surfacing: v1
  // IS the current formula version, so coating rows are correct as-is too.
  // Only ship has the v1→v2 transition.
  if (table === 'daily_ship_targets' && row.formula_version === 2) {
    return { reason: 'already v2' };
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Build the workday list (forward chronological)
// ─────────────────────────────────────────────────────────────────────

const today = ymdToday();
let cursor = today;
const workdays = [];
// Walk back N workdays from today (exclusive of today — today is handled
// by the live writer).
for (let i = 0; i < DAYS; i++) {
  cursor = priorWorkday(cursor);
  workdays.push(cursor);
}
workdays.reverse(); // oldest first → forward chronological

console.log(`Backfilling ${workdays.length} workday(s): ${workdays[0]} → ${workdays[workdays.length - 1]}`);
console.log('');

// ─────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────

let shipWrites = 0, coatingWrites = 0, surfacingWrites = 0;
let shipSkips = 0,  coatingSkips = 0,  surfacingSkips = 0;
const sampleDiffs = [];

for (const ymd of workdays) {
  if (!isWorkday(ymd)) continue;

  const wip = reconstructWIP(ymd);
  if (VERBOSE) {
    console.log(`  ${ymd}: WIP=${wip.active.length} (coating=${wip.coating.length} surfacing=${wip.surfacing.length})`);
  }

  // ── SHIP ──
  if (DEPTS.has('ship') || DEPTS.has('shipping')) {
    const skip = shouldSkip('daily_ship_targets', ymd);
    if (skip) {
      shipSkips++;
      if (VERBOSE) console.log(`    SHIP: skip (${skip.reason})`);
    } else {
      const result = computeShipTarget(db, { today: ymd, wipSnapshot: wip.active });
      const shipped = countShippedOnDay(ymd);
      const variance = shipped - result.target;
      const variancePct = result.target > 0
        ? Math.round((variance / result.target) * 10000) / 100
        : 0;

      // For diagnostic v1 columns: count by classifier directly off the
      // reconstructed WIP (same shape as live captureDailyShipTarget).
      let svWipDiag = 0, surfWipDiag = 0, unkWipDiag = 0;
      for (const r of wip.active) {
        const tier = classify(r.lens_type);
        if (tier === 'SV')        svWipDiag++;
        else if (tier === 'SURF') surfWipDiag++;
        else                      unkWipDiag++;
      }
      const svTargetV1Diag   = Math.ceil(svWipDiag * 0.5);
      const surfTargetV1Diag = Math.ceil((surfWipDiag + unkWipDiag) * 0.33);

      if (APPLY) {
        upsertShip.run(
          ymd, isWorkday(ymd) ? 1 : 0,
          result.svWip, result.surfWip, result.unknownWip,
          svTargetV1Diag, surfTargetV1Diag,
          result.target, shipped, variance, variancePct,
          result.agedWip, result.freshWip,
          result.priorityWeightedWip, result.intakeProjection, result.capacityEstimate,
          result.rolloverIn, result.operationalTarget, result.slaFloor, result.gap
        );
      }
      shipWrites++;
      const existing = db.prepare('SELECT total_target FROM daily_ship_targets WHERE date = ?').get(ymd);
      sampleDiffs.push({
        ymd, dept: 'ship', new: result.target,
        old: existing?.total_target ?? null
      });
    }
  }

  // ── COATING ──
  if (DEPTS.has('coating')) {
    const skip = shouldSkip('daily_coating_targets', ymd);
    if (skip) {
      coatingSkips++;
      if (VERBOSE) console.log(`    COATING: skip (${skip.reason})`);
    } else {
      const result = computeCoatingTarget(db, { today: ymd, wipSnapshot: wip.coating });
      const coatedActual = countStageExitsOnDay('COATING', ymd);
      const variance = coatedActual - (result.target || 0);

      if (APPLY) {
        upsertCoating.run(
          ymd, isWorkday(ymd) ? 1 : 0,
          result.coatingWipCount || 0,
          result.intakeProjection || 0,
          result.capacityEstimate || 0,
          result.rolloverIn || 0,
          result.target || 0,
          coatedActual,
          variance
        );
      }
      coatingWrites++;
      const existing = db.prepare('SELECT total_target FROM daily_coating_targets WHERE date = ?').get(ymd);
      sampleDiffs.push({
        ymd, dept: 'coating', new: result.target,
        old: existing?.total_target ?? null
      });
    }
  }

  // ── SURFACING ──
  if (DEPTS.has('surfacing')) {
    const skip = shouldSkip('daily_surfacing_targets', ymd);
    if (skip) {
      surfacingSkips++;
      if (VERBOSE) console.log(`    SURFACING: skip (${skip.reason})`);
    } else {
      const result = computeSurfacingTarget(db, { today: ymd, wipSnapshot: wip.surfacing });
      const surfacedActual = countStageExitsOnDay('SURFACING', ymd);
      const variance = surfacedActual - (result.target || 0);

      if (APPLY) {
        upsertSurfacing.run(
          ymd, isWorkday(ymd) ? 1 : 0,
          result.surfacingWipCount || 0,
          result.intakeProjection || 0,
          result.capacityEstimate || 0,
          result.rolloverIn || 0,
          result.target || 0,
          surfacedActual,
          variance
        );
      }
      surfacingWrites++;
      const existing = db.prepare('SELECT total_target FROM daily_surfacing_targets WHERE date = ?').get(ymd);
      sampleDiffs.push({
        ymd, dept: 'surfacing', new: result.target,
        old: existing?.total_target ?? null
      });
    }
  }
}

console.log('');
console.log('Summary:');
console.log(`  daily_ship_targets:      ${shipWrites} ${APPLY ? 'wrote' : 'would write'}, ${shipSkips} skipped`);
console.log(`  daily_coating_targets:   ${coatingWrites} ${APPLY ? 'wrote' : 'would write'}, ${coatingSkips} skipped`);
console.log(`  daily_surfacing_targets: ${surfacingWrites} ${APPLY ? 'wrote' : 'would write'}, ${surfacingSkips} skipped`);

if (sampleDiffs.length) {
  // Phil 2026-05-13: show OLDEST 9 + NEWEST 9 so both ends of the
  // window are visible. The middle would just be a wall — the two ends
  // are the ones that matter: oldest tells us how far back job_events
  // has data, newest tells us recent numbers look right.
  const OLDEST_N = 9, NEWEST_N = 9;
  const oldest = sampleDiffs.slice(0, OLDEST_N);
  const newest = sampleDiffs.slice(-NEWEST_N);
  const dedupedNewest = newest.filter(d => !oldest.includes(d));
  const showSample = sampleDiffs.length > OLDEST_N + NEWEST_N
    ? oldest.concat([{ ymd: '─── …', dept: '', new: '', old: '' }], dedupedNewest)
    : sampleDiffs;

  console.log('');
  console.log(`Sample diffs (oldest ${oldest.length} + newest ${dedupedNewest.length} of ${sampleDiffs.length} rows):`);
  for (const d of showSample) {
    if (d.ymd.startsWith('───')) { console.log(`  ${d.ymd}`); continue; }
    const oldStr = d.old == null ? 'no-row' : String(d.old);
    const change = d.old == null ? '(new row)' : (d.new === d.old ? '(no change)' : `(Δ ${d.new - d.old})`);
    console.log(`  ${d.ymd} ${d.dept.padEnd(10)} new=${String(d.new).padStart(5)} old=${oldStr.padStart(5)}  ${change}`);
  }
}

console.log('');
if (!APPLY) {
  console.log('Dry-run complete. Re-run with --apply to write.');
} else {
  console.log('Done.');
}
