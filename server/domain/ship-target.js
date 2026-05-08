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
 * Formula (Phil 2026-05-08):
 *
 *   priorityWeight(j)  = exp( (workdaysInLab(j) - slaWorkdays(j)) / agingExponent )
 *   priorityWeightedWIP = Σ priorityWeight(j) over active WIP
 *   operationalTarget   = round( priorityWeightedWIP + intakeProjection + rolloverIn )
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

const SLA_WORKDAYS = {
  SV:      2,
  SURF:    3,
  UNKNOWN: 2.3,
};

function classify(lensType) {
  const lt = String(lensType || '').toUpperCase().trim();
  if (lt === 'S' || lt === 'C') return 'SV';
  if (lt === 'P' || lt === 'B') return 'SURF';
  return 'UNKNOWN';
}

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
function rolloverFrom(db, today) {
  const prior = priorWorkday(today);
  const row = db.prepare(`
    SELECT total_target, shipped_actual
    FROM daily_ship_targets WHERE date = ?
  `).get(prior);
  if (!row || row.total_target == null) return { rolloverIn: 0, fromDate: prior };
  const miss = Math.max(0, (row.total_target || 0) - (row.shipped_actual || 0));
  return { rolloverIn: miss, fromDate: prior };
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

  const wip = getActiveWIP(db);

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
    const exponent = (days - sla) / cfg.aging_exponent;
    const w = Math.exp(exponent);
    prioritySum += w;

    if (days >= sla) { agedWip++; slaFloorCohort++; }
    else freshWip++;
  }

  const intakeProjection = isWorkday(today) ? intakeRate(db, today, cfg.intake_window_days) : 0;
  const capacityEstimate = capacityRate(db, today, cfg.capacity_window_days);

  const { rolloverIn, fromDate: rolloverFromDate } = rolloverFrom(db, today);
  const slaRolloverIn = slaFloorRolloverFrom(db, today);

  const operationalTarget = isWorkday(today)
    ? Math.round(prioritySum + intakeProjection + rolloverIn)
    : 0;

  const slaFloor = isWorkday(today)
    ? slaFloorCohort + slaRolloverIn
    : 0;

  const target = Math.max(operationalTarget, slaFloor);
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
    rolloverFromDate,
    slaFloorCohort,
    slaFloorRolloverIn: slaRolloverIn,

    // Outputs
    operationalTarget,
    slaFloor,
    target,
    gap,

    // Provenance / tunability
    formulaVersion: 2,
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
  isWorkday,
  priorWorkday,
  loadConfig,
  SLA_WORKDAYS,
};
