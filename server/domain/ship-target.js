'use strict';

/**
 * Daily ship-target computation — v2.
 *
 * Designed to replace the legacy `wip × SLA-fraction` formula in
 * /api/shipping/dashboard with a priority-weighted, carry-forward,
 * capacity-aware model. The function is PURE — it takes a database
 * handle plus optional config overrides, returns a fully-broken-down
 * result struct, and writes nothing. The endpoint serializes; the
 * hourly capture persists; the planning module (forthcoming) will
 * call this with hypothetical inputs for what-if forecasting.
 *
 * Formula (Phil 2026-05-08, revised after first prod run):
 *
 *   sigmoid(j)        = 1 / (1 + exp((slaWorkdays - daysInLab) * 1.5))
 *   overdueBoost(j)   = min(1.0, max(0, (daysInLab - slaWorkdays) * 0.2))
 *   priorityWeight(j) = sigmoid + overdueBoost           // max ~2.0 per job
 *   priorityWeightedWIP = Σ priorityWeight(j) over active WIP
 *
 *   wipExcess         = max(0, activeWipCount - desired_eow_wip)
 *   drainShare        = wipExcess / workdaysRemainingThisWeek
 *
 *   rolloverIn        = max(0, sum_over_workdays_this_week_prior_to_today(target - shipped))
 *                       (cumulative weekly debt; over-ships pay down misses)
 *
 *   operationalTarget = round( max(priorityWeightedWIP, drainShare) + rolloverIn )
 *
 *   intakeFloor       = intakeProjection
 *                       (target must be ≥ incoming rate or queue accumulates)
 *
 *   target            = max(operationalTarget, slaFloor, intakeFloor)
 *
 * The drainShare and priorityWeightedWIP are two independent
 * demand signals (one says "weekly pace," one says "aging
 * urgency"), not additive — taking the max() prevents double
 * counting while letting whichever pulls harder set the bar.
 * On Mon (5 days left) drain is small, priority dominates. On
 * Fri (1 day left) drain absorbs all remaining excess and
 * typically dominates. No arbitrary day-of-week multipliers.
 *
 * Bounded sigmoid replaces unbounded exp() — without the bound, a
 * single stuck/forgotten row with stale entry_date produced a 20-
 * trillion target on the first prod run (2026-05-08). Sigmoid maxes
 * at 1.0 per job; overdueBoost adds up to 1.0 more for past-SLA
 * jobs. Total per-job weight ≤ 2.0.
 *
 * intakeProjection is NOT added to operationalTarget — it's
 * informational only. Today's target is about today's WIP; new
 * incoming jobs are tomorrow's WIP, not today's must-ship.
 *
 *   slaFloor            = count of WIP whose workday SLA deadline ≤ today
 *                         + slaFloorRolloverFromPrior
 *
 *   target              = max(operationalTarget, slaFloor)
 *
 * No capacity cap. The result includes `capacityEstimate` and `gap`
 * (target − capacityEstimate) so the dashboard surfaces staffing
 * pressure as a separate signal. Capacity is a business decision,
 * not a constraint on the target.
 *
 * SLA tiers (Pair Eyewear lens-type → workday SLA):
 *   SV      (lens_type ∈ {S, C}): 2 workdays
 *   Surf    (lens_type ∈ {P, B}): 3 workdays
 *   Unknown (NULL / other):       2.3 workdays  (70/30 blend; bias SV-side)
 *
 * The unknown bucket SHOULD be small after the lens-type recovery
 * backfill runs. Until then, the blend ensures unknowns pressure the
 * target reasonably instead of all rolling into surfacing's gentler
 * 3-day fraction (the v1 bug that produced 670 vs 1,500 expected).
 */

// Canonical classifier moved to ./lens-classifier.js (Phil 2026-05-13:
// "same count, same math, same code"). This module remains the public
// home of SLA_WORKDAYS for backward compatibility with existing
// imports, but the values come from the shared classifier module.
const { classify, SLA_WORKDAYS } = require('./lens-classifier');

/**
 * Workdays (Mon-Fri) between two YYYY-MM-DD dates, inclusive of the
 * later date and exclusive of the earlier — i.e. how many workdays
 * a job has been in lab as of `today`. A job that entered today
 * returns 0; entered yesterday-as-workday returns 1; etc.
 */
function workdaysBetween(entryYMD, todayYMD) {
  if (!entryYMD || !todayYMD) return 0;
  const start = new Date(entryYMD + 'T12:00:00Z');
  const end   = new Date(todayYMD + 'T12:00:00Z');
  if (end <= start) return 0;
  let n = 0;
  const d = new Date(start);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

function isWorkday(ymd) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return dow !== 0 && dow !== 6;
}

function priorWorkday(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Workdays remaining this week including today. Mon=5, Tue=4, …
 * Fri=1. Sat/Sun=0. Used by the drain-share component to spread
 * WIP excess over the remaining workdays of the calendar week.
 */
function workdaysRemainingThisWeek(ymd) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return 0;     // weekend
  return 6 - dow;                            // Mon=1→5, Tue=2→4, ... Fri=5→1
}

/**
 * Read all tunable knobs from lab_planning_config. Falls back to the
 * defaults from migration 009 if a row is missing — keeps the function
 * runnable even on a freshly-cloned dev DB.
 */
function loadConfig(db, overrides) {
  const defaults = {
    aging_exponent:       1.5,
    intake_window_days:   14,
    capacity_window_days: 14,
    rollover_layers:      1,
    desired_eow_wip:      1500,
  };
  const cfg = { ...defaults };
  try {
    const rows = db.prepare('SELECT key, value FROM lab_planning_config').all();
    for (const r of rows) cfg[r.key] = r.value;
  } catch (_) { /* table not yet migrated; use defaults */ }
  if (overrides) Object.assign(cfg, overrides);
  return cfg;
}

/**
 * Active WIP — any job in the jobs table that is still in flight.
 * Pulls entry_date / first_seen_at as the age basis (entry_date is
 * the booking date from DVI; first_seen_at is the trace fallback).
 */
function getActiveWIP(db) {
  return db.prepare(`
    SELECT
      invoice,
      lens_type,
      COALESCE(entry_date, substr(first_seen_at, 1, 10)) AS entry_ymd,
      current_stage,
      status
    FROM jobs
    WHERE status IN ('ACTIVE','Active')
      AND (current_stage IS NULL OR current_stage NOT IN ('CANCELED','SHIPPED','COMPLETE','HOLD'))
  `).all();
}

/**
 * Rolling-window intake projection: count of new jobs entering the
 * lab over the last N workdays, divided by N. Self-tunes to seasonal
 * volume changes; planning module can override `intake_window_days`.
 */
function intakeRate(db, today, windowDays) {
  // Walk back N workdays
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE entry_date IS NOT NULL
      AND entry_date >= ?
      AND entry_date <  ?
  `).get(cursor, today);
  return Math.round((row?.n || 0) / windowDays);
}

/**
 * Rolling-window capacity estimate: avg shipped/day over last N
 * workdays. This is INFORMATIONAL — exposed as `capacityEstimate`
 * + `gap` for staffing decisions, but NOT used to cap the target.
 */
function capacityRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE ship_date IS NOT NULL
      AND ship_date != ''
      AND ship_date >= ?
      AND ship_date <  ?
  `).get(cursor, today);
  return Math.round((row?.n || 0) / windowDays);
}

/**
 * Rollover: max(0, prior-workday target - prior-workday shipped).
 * Single layer (no double-stacking historic misses) per planning
 * recommendation — yesterday's carryover already absorbed the
 * day-before's, so applying yesterday's miss alone is correct.
 */
/**
 * Cumulative weekly rollover (Phil 2026-05-08, revised):
 *
 *   sum, over all workdays this week PRIOR to today, of
 *      (target - shipped)
 *   clamped to >= 0 (over-ships in the week pay down prior misses;
 *   net credit doesn't subtract from today's target).
 *
 * Resets every Monday — the running tab is week-scoped so a bad
 * day weeks ago doesn't haunt us forever. A miss Monday compounds
 * onto Tuesday, Wednesday, etc. until the running variance climbs
 * back to >= 0 (i.e. lab caught up).
 *
 * Returns the debt + the per-day breakdown for transparency in
 * the dashboard tile.
 */
function rolloverFrom(db, today) {
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return { rolloverIn: 0, fromDate: null, weekly: [] };
  // Walk back to Monday of this week
  const cursor = new Date(today + 'T12:00:00Z');
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const monday = cursor.toISOString().slice(0, 10);
  // Pull every workday this week strictly before today
  const rows = db.prepare(`
    SELECT date, total_target, shipped_actual
    FROM daily_ship_targets
    WHERE date >= ? AND date < ?
    ORDER BY date
  `).all(monday, today);
  let netMiss = 0;
  const weekly = [];
  for (const r of rows) {
    const miss = (r.total_target || 0) - (r.shipped_actual || 0);
    netMiss += miss;
    weekly.push({ date: r.date, target: r.total_target, shipped: r.shipped_actual, miss });
  }
  return {
    // Raw uncapped net miss this week so far. Caller applies the cap.
    rolloverRaw: Math.max(0, netMiss),
    // Backwards-compatible alias — same value, caller may cap.
    rolloverIn: Math.max(0, netMiss),
    fromDate: weekly.length ? weekly[weekly.length - 1].date : null,
    weekly,
  };
}

function slaFloorRolloverFrom(db, today) {
  const prior = priorWorkday(today);
  const row = db.prepare(`
    SELECT sla_floor, shipped_actual FROM daily_ship_targets WHERE date = ?
  `).get(prior);
  if (!row || row.sla_floor == null) return 0;
  return Math.max(0, (row.sla_floor || 0) - (row.shipped_actual || 0));
}

/**
 * The main entry point. Returns a structured result with every input,
 * intermediate, and output value — designed for both the dashboard
 * endpoint AND the future planning module's what-if scenarios.
 */
function computeShipTarget(db, options) {
  const today = (options && options.today) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg   = loadConfig(db, options && options.configOverrides);

  // Phil 2026-05-13: backfill-faithfulness. When options.wipSnapshot is
  // provided, use it instead of querying live `jobs`. Lets the faithful
  // backfill script replay the formula against a historical EOD WIP
  // reconstructed from `job_events`. Live callers (endpoint, hourly
  // capture) omit the option and behave identically to before.
  const wip = (options && options.wipSnapshot) || getActiveWIP(db);

  // Per-job priority weight + cohort assignment + SLA-floor flag
  let prioritySum = 0;
  let agedWip = 0, freshWip = 0, unknownWip = 0;
  let svWip = 0, surfWip = 0;
  let slaFloorCohort = 0;
  for (const j of wip) {
    const tier = classify(j.lens_type);
    if (tier === 'SV') svWip++;
    else if (tier === 'SURF') surfWip++;
    else unknownWip++;

    const sla = SLA_WORKDAYS[tier];
    const days = workdaysBetween(j.entry_ymd, today);
    // Bounded sigmoid + capped overdue boost. Each job contributes
    // 0 → ~2.0 to the priority sum. See header comment for rationale.
    const sigmoid = 1 / (1 + Math.exp((sla - days) * cfg.aging_exponent));
    const overdueBoost = Math.min(1, Math.max(0, (days - sla) * 0.2));
    prioritySum += sigmoid + overdueBoost;

    if (days >= sla) { agedWip++; slaFloorCohort++; }
    else freshWip++;
  }

  const intakeProjection = isWorkday(today) ? intakeRate(db, today, cfg.intake_window_days) : 0;
  const capacityEstimate = capacityRate(db, today, cfg.capacity_window_days);

  const { rolloverRaw, fromDate: rolloverFromDate, weekly: weeklyRollover } = rolloverFrom(db, today);
  const slaRolloverIn = slaFloorRolloverFrom(db, today);

  // Phil 2026-05-14: rollover CAP. Without this, two missed days dump
  // full debt onto day 3 → unreachable target (2532 on 5/14 was 1442
  // intake + 1169 raw rollover from Mon/Tue misses → demoralizing).
  // Capped at 1 day's intake. Debt beyond that decays out of the week
  // rather than haunting Thursday/Friday.
  const rolloverIn = Math.min(rolloverRaw, intakeProjection);
  const rolloverCapped = rolloverRaw - rolloverIn;

  // Drain component (Phil 2026-05-08): distribute excess WIP over
  // remaining workdays this week so Friday naturally peaks.
  const wipExcess = Math.max(0, wip.length - cfg.desired_eow_wip);
  const remaining = workdaysRemainingThisWeek(today);
  const drainShare = remaining > 0 ? Math.round(wipExcess / remaining) : 0;

  // intakeProjection is informational only — not added to today's
  // target. New jobs entering today are tomorrow's WIP, not today's
  // must-ship. Adding intake here would double-count (those jobs
  // appear in tomorrow's WIP query already).
  //
  // priorityWeighted and drainShare are independent demand signals;
  // take max() rather than sum to avoid double-counting (a deeply
  // aged job is BOTH part of the priority sum AND part of wipExcess).
  const operationalTarget = isWorkday(today)
    ? Math.round(Math.max(prioritySum, drainShare) + rolloverIn)
    : 0;

  // Phil 2026-05-14: slaFloor CAP, same logic as rolloverIn cap. The lab
  // can't physically ship more than one day's intake regardless of how
  // many jobs are overdue. Without the cap, if 1500+ jobs are past SLA,
  // slaFloor dominates the max() and the target becomes unreachable
  // (defeats the rollover cap). slaFloorRaw exposed for visibility.
  const slaFloorRaw = slaFloorCohort + slaRolloverIn;
  const slaFloor = isWorkday(today)
    ? Math.min(slaFloorRaw, intakeProjection)
    : 0;

  // Intake floor: never plan to ship LESS than the incoming rate,
  // otherwise the queue accumulates day over day. This catches the
  // case where priority + drain are both quiet but new work keeps
  // arriving — we still need to maintain throughput.
  const intakeFloor = isWorkday(today) ? intakeProjection : 0;

  const target = Math.max(operationalTarget, slaFloor, intakeFloor);
  const gap    = target - capacityEstimate;

  return {
    date: today,
    isWorkday: isWorkday(today),

    // Snapshot WIP (signals for planning module)
    activeWipCount:  wip.length,
    svWip, surfWip, unknownWip,
    agedWip, freshWip,

    // Computed components
    priorityWeightedWip: Math.round(prioritySum * 100) / 100,
    intakeProjection,
    capacityEstimate,
    rolloverIn,
    rolloverRaw,
    rolloverCapped,
    rolloverFromDate,
    weeklyRollover,
    slaFloorCohort,
    slaFloorRolloverIn: slaRolloverIn,
    slaFloorRaw,
    intakeFloor,
    wipExcess,
    workdaysRemainingThisWeek: remaining,
    drainShare,

    // Outputs
    operationalTarget,
    slaFloor,
    target,
    gap,

    // Provenance / tunability
    formulaVersion: 3,
    config: {
      aging_exponent:       cfg.aging_exponent,
      intake_window_days:   cfg.intake_window_days,
      capacity_window_days: cfg.capacity_window_days,
      rollover_layers:      cfg.rollover_layers,
      desired_eow_wip:      cfg.desired_eow_wip,
    },
  };
}

module.exports = {
  computeShipTarget,
  // Helpers exported for the test suite + scenario tooling
  classify,
  workdaysBetween,
  workdaysRemainingThisWeek,
  isWorkday,
  priorWorkday,
  loadConfig,
  SLA_WORKDAYS,
};
