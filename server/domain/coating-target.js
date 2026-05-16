'use strict';

/**
 * Daily coating-target computation — v1.
 *
 * Coating is a pure throughput stage: no customer-facing SLA per job,
 * no contractual deadline. Operators see one number: "coat N today."
 *
 * Formula (Phil 2026-05-11):
 *
 *   intakeProjection = 14-workday rolling avg of jobs entering COATING
 *   rolloverIn       = max(0, sum_over_workdays_this_week_prior_to_today(target - coated))
 *   target           = intakeProjection + rolloverIn
 *
 * Pure function — takes a database handle plus optional config overrides,
 * returns a structured result, writes nothing. The endpoint serializes
 * it; the daily capture cron persists; the planning module calls with
 * hypothetical inputs.
 *
 * Differences vs ship-target.js (intentional simplifications):
 *   - No priority-weighted aging. Coating has no customer SLA.
 *   - No drain-share. Pure throughput, no week-pacing pressure.
 *   - No slaFloor. There is no per-job hard deadline.
 *   - Single number — no per-coating-recipe sub-target. Supervisor
 *     manages mix; we just publish total daily volume.
 *
 * Coating stage signal — copied from server/dvi-trace.js:162:
 *   stations matching CCL / CCP / COAT / SENT TO COAT / LCU → stage='COATING'
 *
 * "Entered coating": first job_events row for an invoice with stage='COATING'.
 * "Exited coating":  first job_events row after the last coating event whose
 *                    stage is not COATING/HOLD/CANCELED.
 * Rework re-entries are ignored — entry counted once per invoice.
 */

const {
  workdaysBetween,
  isWorkday,
  priorWorkday,
  workdaysRemainingThisWeek,
} = require('./ship-target');

/**
 * Coating-specific tunables. Reads from the shared lab_planning_config
 * table (migration 011). Falls back to safe defaults if the table or a
 * row is missing — keeps the function runnable on a freshly-cloned dev DB.
 */
function loadConfig(db, overrides) {
  const defaults = {
    coating_intake_window_days: 14,
    coating_rollover_layers:    1,
  };
  const cfg = { ...defaults };
  try {
    const rows = db.prepare(`
      SELECT key, value FROM lab_planning_config
      WHERE key LIKE 'coating_%'
    `).all();
    for (const r of rows) cfg[r.key] = r.value;
  } catch (_) { /* table not yet migrated; use defaults */ }
  if (overrides) Object.assign(cfg, overrides);
  return cfg;
}

/**
 * Coating WIP — jobs currently in the COATING stage. The visible queue
 * that today's target will draw from.
 */
function getCoatingWIP(db) {
  return db.prepare(`
    SELECT invoice, lens_type, coating,
           COALESCE(entry_date, substr(first_seen_at, 1, 10)) AS entry_ymd
    FROM jobs
    WHERE status IN ('ACTIVE','Active')
      AND current_stage = 'COATING'
  `).all();
}

/**
 * Count distinct invoices that *entered* COATING within [sinceYMD, untilYMD).
 * Entry = the invoice's first job_events row with stage='COATING'. Rework
 * re-entries are ignored (one entry per invoice). PT-local day boundaries.
 */
function countCoatingEntries(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    WITH first_coating AS (
      SELECT invoice, MIN(event_ts) AS first_ts
      FROM job_events
      WHERE stage = 'COATING'
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM first_coating
    WHERE date(first_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(first_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(sinceYMD, untilYMD);
  return row?.n || 0;
}

/**
 * Count distinct invoices that REACHED the RECEIVED COAT station within
 * [sinceYMD, untilYMD) — i.e., physically completed coating today.
 *
 * Phil 2026-05-15: redefined to match DVI's authoritative "RECEIVED COAT"
 * counter. Previous definition ("last COATING-stage event today") counted
 * jobs at SENT TO COAT (queue waiting to coat) as completed → over-counted
 * by ~158/day (321 vs DVI's 163 today). After the 2026-05-15 station
 * mapping correction, RECEIVED COAT events route to stage=CUTTING, so the
 * old `WHERE stage='COATING'` query doesn't catch them at all.
 *
 * New definition: invoices touching station='RECEIVED COAT' today =
 * "left coating, queued for cutting" = real completion event. Matches
 * DVI exactly (verified prod query: ours=163, DVI screen=163).
 *
 * Function name kept to avoid breaking callers; semantics changed under
 * the hood. countSurfacingExitsToday + countCuttingExitsToday in
 * daily-capture.js may need similar treatment if they show same gap.
 */
function countCoatingExits(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT invoice) AS n
    FROM job_events
    WHERE station = 'RECEIVED COAT'
      AND date(event_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(event_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(sinceYMD, untilYMD);
  return row?.n || 0;
}

/**
 * Rolling-window intake projection — avg entries-into-coating per workday
 * over the last N workdays. Self-tunes; planning module can override
 * coating_intake_window_days.
 */
function intakeRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const n = countCoatingEntries(db, cursor, today);
  return Math.round(n / windowDays);
}

/**
 * Rolling-window capacity estimate — avg exits-from-coating per workday.
 * Informational, exposed as gap for staffing decisions. Not used to cap
 * the target.
 */
function capacityRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const n = countCoatingExits(db, cursor, today);
  return Math.round(n / windowDays);
}

/**
 * Cumulative weekly rollover — same shape as ship-target.js. Walks back
 * to Monday of this week, sums (target - coated) across prior workdays,
 * clamps to >= 0 so over-shoots earlier in the week pay down later
 * misses without producing negative carry.
 *
 * Returns the debt + per-day breakdown for dashboard transparency.
 */
function rolloverFrom(db, today) {
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return { rolloverIn: 0, fromDate: null, weekly: [] };
  const cursor = new Date(today + 'T12:00:00Z');
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const monday = cursor.toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT date, total_target, coated_actual
    FROM daily_coating_targets
    WHERE date >= ? AND date < ?
    ORDER BY date
  `).all(monday, today);
  let netMiss = 0;
  const weekly = [];
  for (const r of rows) {
    const miss = (r.total_target || 0) - (r.coated_actual || 0);
    netMiss += miss;
    weekly.push({ date: r.date, target: r.total_target, coated: r.coated_actual, miss });
  }
  return {
    rolloverIn: Math.max(0, netMiss),
    fromDate: weekly.length ? weekly[weekly.length - 1].date : null,
    weekly,
  };
}

/**
 * Main entry point. Structured result with every input, intermediate,
 * and output value — designed for both the dashboard endpoint AND the
 * future planning module's what-if scenarios.
 */
/**
 * Phil 2026-05-13: backfill-faithfulness. options.wipSnapshot lets a
 * historical replay supply an EOD WIP reconstruction; live callers
 * omit and the function pulls today's WIP from jobs as before.
 *
 * Phil 2026-05-14: added upstreamDemand signal. Previously the formula
 * was `intakeProjection + rolloverIn` — 14-day rolling avg of coating
 * entries. Descriptive, not prescriptive: if surfacing dumps 1,500
 * semi-finished jobs into the pipeline today, the goal still reads as
 * the historical entry rate (409) instead of reflecting actual demand
 * about to hit coating.
 *
 * upstreamDemand = count of jobs in upstream stages (SURFACING,
 * BLOCKING, PICKING) whose lens_type is semi-finished (P/B) — these
 * are committed to coating once they finish their current stage.
 *
 * Formula now:
 *   operationalTarget = max(intakeProjection, upstreamDemand) + rolloverIn
 *   target            = operationalTarget (or 0 on non-workdays)
 *
 * Take the max so the formula reflects whichever signal is bigger:
 * historical pace OR actual pipeline pressure. No double-count.
 */
// Phil 2026-05-14: v4 — flow-time-aware upstream demand. Replaces the
// "count all upstream jobs" naïve query (v3) with three separate counts
// the formula combines below:
//
//   1. realisticArrivals: SURF jobs upstream whose remaining p50 dwell
//      hours fits within hoursLeftInWorkday — physically can reach
//      coating today.
//   2. agingOverride: SURF jobs at upstream stages already past their
//      SLA (per lens-classifier.SLA_WORKDAYS). Must coat today regardless
//      of process time.
//   3. coatingWipCount: SURF jobs already AT coating.
//
// SV jobs are excluded — coating dept doesn't process them (they go
// pick → cut → asm → ship). See plan: cheeky-wandering-hollerith.md.
function getCoatingUpstreamSignals(db, today) {
  const dwellEst = require('./dwell-estimator');
  const { classifyJobRow, SLA_WORKDAYS } = require('./lens-classifier');
  const { workdaysBetween } = require('./ship-target');

  try {
    // Phil 2026-05-15: jobs MUST be picked-or-WIP. Exclude INCOMING and
    // AT_KARDEX (haven't been picked into the system yet — can't be
    // promised as today's coating capacity). Per Phil: "If it's not in
    // the WIP or picked, it's impossible to invent."
    const upstream = db.prepare(`
      SELECT invoice, current_stage, entry_date, lens_type,
             lens_pick_r, lens_pick_l, lens_opc_r, lens_opc_l
      FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage IN ('PICKING','SURFACING','BLOCKING')
    `).all();

    const hoursLeft = dwellEst.computeHoursLeftInWorkday(db);
    // Phil 2026-05-15: throughput-based cap. Coating can't process more
    // than (lenses-per-hour × hoursLeft) regardless of how many jobs are
    // queued upstream. Pull throughput from SOM (or fallback default).
    const throughputPerHr = dwellEst.getCategoryThroughputPerHour(db, 'coating');
    const physicallyProcessableToday = Math.floor(throughputPerHr * hoursLeft);

    let queuedSurf = 0;
    let agingOverride = 0;

    for (const j of upstream) {
      const tier = classifyJobRow(j);
      if (tier !== 'SURF' && tier !== 'UNKNOWN') continue; // SV won't hit coating
      queuedSurf++;
      const slaWd = SLA_WORKDAYS[tier === 'UNKNOWN' ? 'UNKNOWN' : 'SURF'] || SLA_WORKDAYS.UNKNOWN;
      const days = j.entry_date ? workdaysBetween(j.entry_date, today) : 0;
      if (days >= slaWd) agingOverride++;
    }

    // Realistic arrivals = min(jobs queued upstream, what we can physically
    // process today). Beyond that, additional queue is tomorrow's problem.
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

function computeCoatingTarget(db, options) {
  const today = (options && options.today) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg   = loadConfig(db, options && options.configOverrides);

  const wip = (options && options.wipSnapshot) || getCoatingWIP(db);

  const intakeProjection = isWorkday(today)
    ? intakeRate(db, today, cfg.coating_intake_window_days)
    : 0;
  const capacityEstimate = capacityRate(db, today, cfg.coating_intake_window_days);

  const { rolloverIn: rolloverRaw, fromDate: rolloverFromDate, weekly: weeklyRollover } = rolloverFrom(db, today);
  // Phil 2026-05-14: cap rollover at intake (same as ship-target). Without
  // this, a weeklong miss compounds into an unreachable single-day target.
  const rolloverIn = Math.min(rolloverRaw, intakeProjection);
  const rolloverCapped = rolloverRaw - rolloverIn;

  // v4: throughput-aware signals
  const upstream = (options && options.wipSnapshot)
    ? { realisticArrivals: 0, agingOverride: 0, surfUpstreamTotal: 0, hoursLeft: 0, throughputPerHr: 0, physicallyProcessableToday: 0 }
    : getCoatingUpstreamSignals(db, today);

  // operationalTarget = whichever is largest of:
  //   (a) historical 14d intake rate (don't fall behind average pace)
  //   (b) realistic arrivals + currently-at-coating WIP (today's actual feasible work)
  //   (c) aging override (overdue SURF jobs that MUST coat today)
  // ... plus capped rollover.
  const operationalTarget = isWorkday(today)
    ? Math.max(intakeProjection, upstream.realisticArrivals + wip.length, upstream.agingOverride) + rolloverIn
    : 0;
  const target = operationalTarget;
  const gap    = target - capacityEstimate;

  return {
    date: today,
    isWorkday: isWorkday(today),

    coatingWipCount: wip.length,

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

    formulaVersion: 4,
    config: {
      coating_intake_window_days: cfg.coating_intake_window_days,
      coating_rollover_layers:    cfg.coating_rollover_layers,
    },
  };
}

module.exports = {
  computeCoatingTarget,
  // Helpers exported for tests + scenario tooling
  loadConfig,
  getCoatingWIP,
  countCoatingEntries,
  countCoatingExits,
  intakeRate,
  capacityRate,
  rolloverFrom,
};
