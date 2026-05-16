'use strict';

/**
 * Daily assembly-target computation — v1.
 *
 * Phil 2026-05-15: assembly was previously sharing the ship-target value.
 * Wrong — assembly has its own demand:
 *
 *   demand = projected-cut-completions-today (everything coming out of cut,
 *            both SV and SURF branches)
 *          + currently-AT-ASSEMBLY WIP
 *
 *   target = max(realistic demand, agingOverride, intakeFloor)
 *           , capped by assembly throughput × hoursLeft
 *
 * Per Phil 2026-05-15: "Assembly goal is an accumulation of everything
 * coming out of cutting and surfacing based on that day's needs. If you
 * have 6,000 jobs in the WIP, obviously your assembly goal is not 6,000;
 * it has to be realistic based on what you need to get out for the day
 * to keep your WIP under your aging profile for your SLA."
 *
 * Plan: /Users/phil/.claude/plans/cheeky-wandering-hollerith.md.
 */

const dwellEst = require('./dwell-estimator');
const { classifyJobRow, SLA_WORKDAYS } = require('./lens-classifier');
// Phil 2026-05-16: aging = calendar days (calendarDaysBetween), not workdays.
const { workdaysBetween, calendarDaysBetween, isWorkday, priorWorkday } = require('./ship-target');
const { computeCuttingTarget } = require('./cutting-target');

function loadConfig(db, overrides) {
  const defaults = {
    assembly_intake_window_days: 14,
  };
  const cfg = { ...defaults };
  try {
    const rows = db.prepare(`
      SELECT key, value FROM lab_planning_config WHERE key LIKE 'assembly_%'
    `).all();
    for (const r of rows) cfg[r.key] = r.value;
  } catch (_) { /* table not migrated */ }
  if (overrides) Object.assign(cfg, overrides);
  return cfg;
}

function getAssemblyWIP(db) {
  return db.prepare(`
    SELECT invoice, lens_type FROM jobs
    WHERE status IN ('ACTIVE','Active') AND current_stage = 'ASSEMBLY'
  `).all();
}

function getAssemblySignals(db, today) {
  try {
    const upstream = db.prepare(`
      SELECT invoice, current_stage, entry_date, lens_type,
             lens_pick_r, lens_pick_l, lens_opc_r, lens_opc_l
      FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage IN ('CUTTING','ASSEMBLY')
    `).all();

    let cuttingWip = 0;
    let assemblyWip = 0;
    let agingOverride = 0;

    for (const j of upstream) {
      const tier = classifyJobRow(j);
      if (j.current_stage === 'ASSEMBLY') assemblyWip++;
      else if (j.current_stage === 'CUTTING') cuttingWip++;

      const slaWd = SLA_WORKDAYS[tier === 'UNKNOWN' ? 'UNKNOWN' : tier]
        || SLA_WORKDAYS.UNKNOWN;
      const days = j.entry_date ? calendarDaysBetween(j.entry_date, today) : 0;
      if (days >= slaWd) agingOverride++;
    }

    return { cuttingWip, assemblyWip, agingOverride };
  } catch (e) {
    return { cuttingWip: 0, assemblyWip: 0, agingOverride: 0, error: e.message };
  }
}

function intakeRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  try {
    const row = db.prepare(`
      WITH first_assembly AS (
        SELECT invoice, MIN(event_ts) AS first_ts
        FROM job_events WHERE stage = 'ASSEMBLY'
        GROUP BY invoice
      )
      SELECT COUNT(*) AS n FROM first_assembly
      WHERE date(first_ts/1000, 'unixepoch','localtime') >= ?
        AND date(first_ts/1000, 'unixepoch','localtime') <  ?
    `).get(cursor, today);
    return Math.round((row?.n || 0) / windowDays);
  } catch (_) { return 0; }
}

function computeAssemblyTarget(db, options) {
  const today = (options && options.today) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg = loadConfig(db, options && options.configOverrides);

  const wip = (options && options.wipSnapshot) || getAssemblyWIP(db);
  const signals = (options && options.wipSnapshot)
    ? { cuttingWip: 0, assemblyWip: wip.length, agingOverride: 0 }
    : getAssemblySignals(db, today);

  const intakeProjection = isWorkday(today)
    ? intakeRate(db, today, cfg.assembly_intake_window_days)
    : 0;

  const hoursLeft = dwellEst.computeHoursLeftInWorkday(db);
  const assemblyThroughput = dwellEst.getCategoryThroughputPerHour(db, 'assembly');
  const physicallyProcessableToday = Math.floor(assemblyThroughput * hoursLeft);

  // Projected cut completions today = cutting target's realisticArrivals.
  // That's already capacity-bounded by cut throughput, so we don't double-cap.
  let projectedFromCutting = 0;
  if (!(options && options.wipSnapshot)) {
    try {
      const cutResult = computeCuttingTarget(db, options);
      projectedFromCutting = cutResult.realisticArrivals || 0;
    } catch (_) { projectedFromCutting = signals.cuttingWip; }
  }

  // Realistic demand at assembly today
  const realisticDemand = projectedFromCutting + signals.assemblyWip;
  const realisticArrivals = Math.min(realisticDemand, physicallyProcessableToday);

  const operationalTarget = isWorkday(today)
    ? Math.max(intakeProjection, realisticArrivals, signals.agingOverride)
    : 0;
  const target = operationalTarget;

  return {
    date: today,
    isWorkday: isWorkday(today),

    assemblyWipCount:            wip.length,
    cuttingWipCount:             signals.cuttingWip,
    intakeProjection,

    projectedFromCutting,
    realisticArrivals,
    agingOverride:               signals.agingOverride,
    physicallyProcessableToday,
    throughputPerHourSom:        assemblyThroughput,
    hoursLeftInWorkday:          hoursLeft,

    operationalTarget,
    target,

    formulaVersion: 1,
    config: {
      assembly_intake_window_days: cfg.assembly_intake_window_days,
    },
  };
}

module.exports = {
  computeAssemblyTarget,
  getAssemblySignals,
  getAssemblyWIP,
  loadConfig,
  intakeRate,
};
