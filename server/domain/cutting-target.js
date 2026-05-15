'use strict';

/**
 * Daily cutting-target computation — v1.
 *
 * Phil 2026-05-15: cutting was previously sharing the ship-target value
 * (every dept tile downstream of coating just showed the lab-wide ship
 * target). That's wrong — cutting has its own demand:
 *
 *   demand = SV-jobs-at-PICKING (will branch directly to cut)
 *          + SURF-jobs-projected-from-coating-today
 *          + currently-AT-CUTTING WIP
 *
 *   target = max(realistic arrivals + cutWip, agingOverride, intakeFloor)
 *           , capped by cutting throughput × hoursLeft  (capacity realism)
 *
 * Constraints:
 * - Phil 2026-05-15: only count picked-or-WIP jobs. Jobs at INCOMING /
 *   AT_KARDEX haven't been picked into the system yet — can't be invented
 *   as today's cuttable work.
 * - Aging override: jobs past SLA must cut today regardless of throughput.
 * - SV jobs that haven't been picked don't count (no lens to cut yet);
 *   SV jobs at PICKING WILL be picked + cut today (typically same shift).
 *
 * Bot SV and SURF converge at cutting. The classifier looks at the pick
 * SKU to decide branch:
 *   SV → pick → cut → assembly → ship
 *   SURF → pick → surface line → coating dept → cut → assembly → ship
 *
 * Plan: /Users/phil/.claude/plans/cheeky-wandering-hollerith.md.
 */

const dwellEst = require('./dwell-estimator');
const { classifyJobRow, SLA_WORKDAYS } = require('./lens-classifier');
const { workdaysBetween, isWorkday, workdaysRemainingThisWeek, priorWorkday } = require('./ship-target');

function loadConfig(db, overrides) {
  const defaults = {
    cutting_intake_window_days: 14,
    cutting_rollover_layers:    1,
  };
  const cfg = { ...defaults };
  try {
    const rows = db.prepare(`
      SELECT key, value FROM lab_planning_config WHERE key LIKE 'cutting_%'
    `).all();
    for (const r of rows) cfg[r.key] = r.value;
  } catch (_) { /* table not migrated */ }
  if (overrides) Object.assign(cfg, overrides);
  return cfg;
}

function getCuttingWIP(db) {
  return db.prepare(`
    SELECT invoice, lens_type, lens_pick_r, lens_pick_l, lens_opc_r, lens_opc_l
    FROM jobs
    WHERE status IN ('ACTIVE','Active') AND current_stage = 'CUTTING'
  `).all();
}

/**
 * Count jobs currently in the cutting pipeline (PICKING through CUTTING).
 * Per Phil 2026-05-15: must be picked-or-WIP. Excludes INCOMING/AT_KARDEX.
 *
 * Returns counts split SV vs SURF using lens_pick / lens_opc classifier:
 *   svAtPicking      — SV jobs at PICKING (will go straight to cut)
 *   surfUpstreamCut  — SURF jobs at PICKING/SURFACING/BLOCKING/COATING
 *                       (will eventually arrive at cut)
 *   surfAtCoating    — SURF jobs currently AT COATING (one stage from cut)
 *   atCuttingWip     — already at CUTTING
 *   agingOverride    — jobs past SLA somewhere in the cutting pipeline
 */
function getCuttingPipelineSignals(db, today) {
  try {
    const upstream = db.prepare(`
      SELECT invoice, current_stage, entry_date, lens_type,
             lens_pick_r, lens_pick_l, lens_opc_r, lens_opc_l
      FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage IN ('PICKING','SURFACING','BLOCKING','COATING','CUTTING')
    `).all();

    let svAtPicking = 0;
    let surfUpstreamCut = 0;
    let surfAtCoating = 0;
    let atCuttingWip = 0;
    let agingOverride = 0;

    for (const j of upstream) {
      const tier = classifyJobRow(j);
      const stage = j.current_stage;

      if (stage === 'CUTTING') {
        atCuttingWip++;
      } else if (tier === 'SV' && stage === 'PICKING') {
        // SV at PICKING — will be picked and head straight to cut today
        svAtPicking++;
      } else if (tier === 'SURF' || tier === 'UNKNOWN') {
        // SURF in upstream → has to traverse remaining stages to reach cut
        surfUpstreamCut++;
        if (stage === 'COATING') surfAtCoating++;
      }
      // else: SV at SURFACING/BLOCKING/COATING shouldn't really happen
      // (SV bypasses those). Skip.

      const slaWd = SLA_WORKDAYS[tier === 'UNKNOWN' ? 'UNKNOWN' : tier]
        || SLA_WORKDAYS.UNKNOWN;
      const days = j.entry_date ? workdaysBetween(j.entry_date, today) : 0;
      if (days >= slaWd) agingOverride++;
    }

    return { svAtPicking, surfUpstreamCut, surfAtCoating, atCuttingWip, agingOverride };
  } catch (e) {
    return { svAtPicking: 0, surfUpstreamCut: 0, surfAtCoating: 0, atCuttingWip: 0, agingOverride: 0, error: e.message };
  }
}

/**
 * Estimate SURF jobs that will arrive at cutting today: capped by what
 * coating can physically push out (coating throughput × hoursLeft minus
 * coating's existing WIP).
 */
function estimateSurfArrivalsAtCuttingToday(db, signals, hoursLeft) {
  // Coating output today = throughput × hoursLeft, but bounded by what's
  // upstream of cut (signals.surfUpstreamCut). The jobs at COATING are
  // closest to arriving — count them first; jobs further upstream are
  // less likely to make it through coating today.
  const coatingThroughput = dwellEst.getCategoryThroughputPerHour(db, 'coating');
  const coatingCanOutput = Math.floor(coatingThroughput * hoursLeft);
  // The min of (surf jobs that need to arrive at cut) and (coating capacity)
  return Math.min(signals.surfUpstreamCut, coatingCanOutput);
}

function intakeRate(db, today, windowDays) {
  // Cutting "intake" = jobs entering the CUTTING stage per workday avg.
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  try {
    const row = db.prepare(`
      WITH first_cutting AS (
        SELECT invoice, MIN(event_ts) AS first_ts
        FROM job_events WHERE stage = 'CUTTING'
        GROUP BY invoice
      )
      SELECT COUNT(*) AS n FROM first_cutting
      WHERE date(first_ts/1000, 'unixepoch','localtime') >= ?
        AND date(first_ts/1000, 'unixepoch','localtime') <  ?
    `).get(cursor, today);
    return Math.round((row?.n || 0) / windowDays);
  } catch (_) { return 0; }
}

function rolloverFrom(db, today) {
  // No daily_cutting_targets table yet — return zero rollover. Can be
  // populated in a future migration if cutting capture is added.
  return { rolloverIn: 0, weekly: [] };
}

function computeCuttingTarget(db, options) {
  const today = (options && options.today) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg = loadConfig(db, options && options.configOverrides);

  const wip = (options && options.wipSnapshot) || getCuttingWIP(db);

  const intakeProjection = isWorkday(today)
    ? intakeRate(db, today, cfg.cutting_intake_window_days)
    : 0;

  const signals = (options && options.wipSnapshot)
    ? { svAtPicking: 0, surfUpstreamCut: 0, surfAtCoating: 0, atCuttingWip: wip.length, agingOverride: 0 }
    : getCuttingPipelineSignals(db, today);

  const hoursLeft = dwellEst.computeHoursLeftInWorkday(db);
  const cuttingThroughput = dwellEst.getCategoryThroughputPerHour(db, 'cutting');
  const physicallyProcessableToday = Math.floor(cuttingThroughput * hoursLeft);

  // Realistic SURF arrivals at cutting = bounded by coating throughput
  const surfArrivals = estimateSurfArrivalsAtCuttingToday(db, signals, hoursLeft);

  // Total demand = SV directly arriving + SURF arrivals + already-at-cut WIP
  const realisticDemand = signals.svAtPicking + surfArrivals + signals.atCuttingWip;

  // Cap demand at cutting's own physical processing capacity
  const realisticArrivals = Math.min(realisticDemand, physicallyProcessableToday);

  // Phil 2026-05-15: SV/SURF breakdown for operator visibility. When cut
  // is capacity-constrained, SV and SURF compete for the same machines.
  // Allocate SURF first (it has nowhere else to go), then SV gets the
  // remainder. Per Phil's scenario B: heavy SURF flow squeezes SV cut
  // output even with plenty of SV at PICKING.
  const surfCutToday = Math.min(surfArrivals + 0, realisticArrivals);
  const remainingForSv = Math.max(0, realisticArrivals - surfCutToday);
  const svCutToday = Math.min(signals.svAtPicking + 0, remainingForSv);

  const { rolloverIn } = rolloverFrom(db, today);

  // Final target: the max of (realistic capacity-bounded demand, aging),
  // backstopped by intake floor. Aging overrides physical capacity because
  // SLA-breached jobs MUST coat today even if it pushes overtime.
  const operationalTarget = isWorkday(today)
    ? Math.max(intakeProjection, realisticArrivals, signals.agingOverride) + rolloverIn
    : 0;
  const target = operationalTarget;

  return {
    date: today,
    isWorkday: isWorkday(today),

    cuttingWipCount:             wip.length,
    intakeProjection,

    svAtPicking:                 signals.svAtPicking,
    surfUpstreamCut:             signals.surfUpstreamCut,
    surfAtCoating:               signals.surfAtCoating,
    realisticArrivals,
    svCutToday,                  // breakdown: how many SV will cut today
    surfCutToday,                // breakdown: how many SURF will cut today
    agingOverride:               signals.agingOverride,
    physicallyProcessableToday,
    throughputPerHourSom:        cuttingThroughput,
    hoursLeftInWorkday:          hoursLeft,
    rolloverIn,

    operationalTarget,
    target,

    formulaVersion: 1,
    config: {
      cutting_intake_window_days: cfg.cutting_intake_window_days,
      cutting_rollover_layers:    cfg.cutting_rollover_layers,
    },
  };
}

module.exports = {
  computeCuttingTarget,
  getCuttingPipelineSignals,
  getCuttingWIP,
  loadConfig,
  intakeRate,
};
