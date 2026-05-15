'use strict';

/**
 * Daily surfacing-target computation — v1.
 *
 * Phil 2026-05-13 evening: surfacing is the upstream master throughput
 * target. Previously /api/surfacing/target returned coating's number
 * (409 today) as a stopgap. The real number, per Phil's stated mental
 * model and the lab physics, is closer to 1,200 — surfacing produces
 * everything that downstream stages (cutting, coating, assembly,
 * shipping) consume, including SV lenses that skip coating entirely.
 *
 * Formula (mirrors coating-target.js — pure throughput stage, no SLA
 * escalation):
 *
 *   intakeProjection = 14-workday rolling avg of distinct invoices
 *                      whose first SURFACING stage event fell within
 *                      [today - N workdays, today)
 *   rolloverIn       = sum(target - surfaced_actual) for prior workdays
 *                      this week, clamped to >= 0
 *   target           = intakeProjection + rolloverIn   (workdays only)
 *
 * surfaced_actual counted via "last SURFACING event today" — same rule
 * as countSurfacingExitsToday in daily-capture.js (which the per-row
 * actuals capture writes into daily_dept_actuals). Single source of
 * truth for the surfacing actual number across all surfaces.
 *
 * No customer-SLA floor — surfacing has no contractual deadline per
 * job (the lens-type SLAs are end-to-end, measured from intake to
 * ship). Pace pressure comes from intake (new work must be absorbed)
 * + rollover (this week's accumulated debt).
 */

const path = require('path');
const { classify } = require('./lens-classifier');

// ─────────────────────────────────────────────────────────────────────
// Date helpers (mirror ship-target.js — same conventions)
// ─────────────────────────────────────────────────────────────────────

function isWorkday(ymd) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return dow !== 0 && dow !== 6;
}

function priorWorkday(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function workdaysRemainingThisWeek(ymd) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return 0;
  return 6 - dow;
}

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

function loadConfig(db, overrides) {
  const defaults = {
    surfacing_intake_window_days: 14,
    surfacing_rollover_layers:    1,
  };
  const cfg = { ...defaults };
  try {
    const rows = db.prepare('SELECT key, value FROM lab_planning_config').all();
    for (const r of rows) cfg[r.key] = r.value;
  } catch (_) { /* not yet migrated */ }
  if (overrides) Object.assign(cfg, overrides);
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────
// WIP query (point-in-time = now). Overridable via options.wipSnapshot
// for backfill replay (see ship-target.js / coating-target.js for the
// same pattern).
// ─────────────────────────────────────────────────────────────────────

function getSurfacingWIP(db) {
  return db.prepare(`
    SELECT invoice, lens_type,
           COALESCE(entry_date, substr(first_seen_at, 1, 10)) AS entry_ymd
    FROM jobs
    WHERE status IN ('ACTIVE','Active')
      AND current_stage = 'SURFACING'
  `).all();
}

// ─────────────────────────────────────────────────────────────────────
// Intake / capacity (deterministic — pulls from job_events)
// ─────────────────────────────────────────────────────────────────────

/**
 * Count distinct invoices whose FIRST SURFACING event falls in
 * [sinceYMD, untilYMD). The "intake into surfacing" event — when the
 * invoice first appears at a surfacing-line station.
 */
function countSurfacingEntries(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    WITH first_surfacing AS (
      SELECT invoice, MIN(event_ts) AS first_ts
      FROM job_events
      WHERE stage = 'SURFACING'
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM first_surfacing
    WHERE date(first_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(first_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(sinceYMD, untilYMD);
  return row?.n || 0;
}

/**
 * Count distinct invoices whose LAST SURFACING event falls in
 * [sinceYMD, untilYMD). "Completed surfacing today" — same definition
 * as countSurfacingExitsToday in daily-capture.js. Includes mid-
 * surfacing jobs (their last surfacing-line touch is today even if
 * they haven't advanced yet) — intentional, matches Phil's spoken
 * "today's surfacing activity."
 */
function countSurfacingExits(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    WITH last_surfacing AS (
      SELECT invoice, MAX(event_ts) AS last_ts
      FROM job_events
      WHERE stage = 'SURFACING'
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM last_surfacing
    WHERE date(last_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(last_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(sinceYMD, untilYMD);
  return row?.n || 0;
}

function intakeRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const n = countSurfacingEntries(db, cursor, today);
  return Math.round(n / windowDays);
}

function capacityRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const n = countSurfacingExits(db, cursor, today);
  return Math.round(n / windowDays);
}

// ─────────────────────────────────────────────────────────────────────
// Rollover (cumulative weekly debt — mirrors coating-target.js)
// ─────────────────────────────────────────────────────────────────────

function rolloverFrom(db, today) {
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return { rolloverIn: 0, fromDate: null, weekly: [] };
  const cursor = new Date(today + 'T12:00:00Z');
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const monday = cursor.toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT date, total_target, surfaced_actual
    FROM daily_surfacing_targets
    WHERE date >= ? AND date < ?
    ORDER BY date
  `).all(monday, today);
  let netMiss = 0;
  const weekly = [];
  for (const r of rows) {
    const miss = (r.total_target || 0) - (r.surfaced_actual || 0);
    netMiss += miss;
    weekly.push({ date: r.date, target: r.total_target, surfaced: r.surfaced_actual, miss });
  }
  return {
    rolloverRaw: Math.max(0, netMiss),
    rolloverIn: Math.max(0, netMiss),
    fromDate: weekly.length ? weekly[weekly.length - 1].date : null,
    weekly,
  };
}

// Phil 2026-05-14 v3: flow-time-aware upstream signals for surfacing.
// Mirrors coating-target.js v4. Three counts:
//   1. realisticArrivals — SURF jobs at PICKING that can reach SURFACING
//      today given empirical p50 dwell. PICKING typically <1h so most
//      will arrive same-day.
//   2. agingOverride — SURF jobs upstream of (or at) surfacing already
//      past SLA. Must surface today regardless.
//   3. surfacingWip — already at SURFACING/BLOCKING. They're in flight.
// SV jobs excluded — they don't need surfacing.
function getSurfacingUpstreamSignals(db, today) {
  const dwellEst = require('./dwell-estimator');
  const { classifyJobRow, SLA_WORKDAYS } = require('./lens-classifier');
  const { workdaysBetween } = require('./ship-target');

  try {
    // Phil 2026-05-15: picked-or-WIP only — exclude INCOMING/AT_KARDEX.
    const upstream = db.prepare(`
      SELECT invoice, current_stage, entry_date, lens_type,
             lens_pick_r, lens_pick_l, lens_opc_r, lens_opc_l
      FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage IN ('PICKING','SURFACING','BLOCKING')
    `).all();

    const hoursLeft = dwellEst.computeHoursLeftInWorkday(db);
    const throughputPerHr = dwellEst.getCategoryThroughputPerHour(db, 'surfacing');
    const physicallyProcessableToday = Math.floor(throughputPerHr * hoursLeft);

    let queuedSurf = 0;
    let agingOverride = 0;

    for (const j of upstream) {
      const tier = classifyJobRow(j);
      if (tier !== 'SURF' && tier !== 'UNKNOWN') continue;
      queuedSurf++;
      const slaWd = SLA_WORKDAYS[tier === 'UNKNOWN' ? 'UNKNOWN' : 'SURF'] || SLA_WORKDAYS.UNKNOWN;
      const days = j.entry_date ? workdaysBetween(j.entry_date, today) : 0;
      if (days >= slaWd) agingOverride++;
    }

    const realisticArrivals = Math.min(queuedSurf, physicallyProcessableToday);

    return {
      realisticArrivals, agingOverride,
      surfUpstreamTotal: queuedSurf,
      hoursLeft, throughputPerHr,
      physicallyProcessableToday,
    };
  } catch (e) {
    return { realisticArrivals: 0, agingOverride: 0, surfUpstreamTotal: 0, hoursLeft: 0, throughputPerHr: 0, physicallyProcessableToday: 0, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Phil 2026-05-13: options.wipSnapshot lets a historical replay supply
 * an EOD WIP reconstruction; live callers omit and the function pulls
 * today's WIP from jobs as before.
 */
function computeSurfacingTarget(db, options) {
  const today = (options && options.today)
    || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg = loadConfig(db, options && options.configOverrides);

  const wip = (options && options.wipSnapshot) || getSurfacingWIP(db);

  const intakeProjection = isWorkday(today)
    ? intakeRate(db, today, cfg.surfacing_intake_window_days)
    : 0;
  const capacityEstimate = capacityRate(db, today, cfg.surfacing_intake_window_days);

  const { rolloverRaw, fromDate: rolloverFromDate, weekly: weeklyRollover } = rolloverFrom(db, today);

  // Phil 2026-05-14: rollover CAP — same logic as ship-target.js. Without
  // this, two missed days dump full debt onto day 3, producing an
  // unreachable target.
  const rolloverIn = Math.min(rolloverRaw, intakeProjection);
  const rolloverCapped = rolloverRaw - rolloverIn;

  // v3: throughput-capped signals — see getSurfacingUpstreamSignals.
  const upstream = (options && options.wipSnapshot)
    ? { realisticArrivals: 0, agingOverride: 0, surfUpstreamTotal: 0, hoursLeft: 0, throughputPerHr: 0, physicallyProcessableToday: 0 }
    : getSurfacingUpstreamSignals(db, today);

  const operationalTarget = isWorkday(today)
    ? Math.max(intakeProjection, upstream.realisticArrivals, upstream.agingOverride) + rolloverIn
    : 0;
  const target = operationalTarget;
  const gap    = target - capacityEstimate;

  return {
    date: today,
    isWorkday: isWorkday(today),

    surfacingWipCount: wip.length,

    intakeProjection,
    realisticArrivals:           upstream.realisticArrivals,
    agingOverride:               upstream.agingOverride,
    surfUpstreamTotal:           upstream.surfUpstreamTotal,
    hoursLeftInWorkday:          upstream.hoursLeft,
    throughputPerHourSom:        upstream.throughputPerHr,
    physicallyProcessableToday:  upstream.physicallyProcessableToday,
    capacityEstimate,
    rolloverIn,
    rolloverRaw,
    rolloverCapped,
    rolloverFromDate,
    weeklyRollover,
    workdaysRemainingThisWeek: workdaysRemainingThisWeek(today),

    operationalTarget,
    target,
    gap,

    formulaVersion: 3,
    config: {
      surfacing_intake_window_days: cfg.surfacing_intake_window_days,
      surfacing_rollover_layers:    cfg.surfacing_rollover_layers,
    },
  };
}

module.exports = {
  computeSurfacingTarget,
  countSurfacingEntries,
  countSurfacingExits,
  intakeRate,
  capacityRate,
  rolloverFrom,
  isWorkday,
  priorWorkday,
  workdaysRemainingThisWeek,
  loadConfig,
  getSurfacingWIP,
};
