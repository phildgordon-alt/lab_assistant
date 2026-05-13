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
 * Count distinct invoices whose LAST COATING event falls in [sinceYMD, untilYMD).
 *
 * Phil 2026-05-13: redefined from "first post-coating event today" → "last
 * coating event today." The old definition counted only invoices that had
 * never appeared downstream until today, which excluded most invoices that
 * coated yesterday and shipped today (they coated again? no — the previous
 * day's downstream event made today's shipping not count). 2026-05-13 prod
 * diagnostic returned 8 with the old definition vs 882 underlying post-
 * coating events from coated invoices same day. The new definition matches
 * the spoken phrase "completed coating today" — the last time we touched
 * the invoice on a coater was today. Includes mid-coating jobs (their last
 * coating event is today, even though they haven't advanced yet) which is
 * intentional: that's "today's coating activity."
 *
 * Function name kept (`countCoatingExits`) to avoid touching every caller;
 * semantics changed under the hood. Same redefinition applied to
 * countSurfacingExitsToday and countCuttingExitsToday in daily-capture.js.
 */
function countCoatingExits(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    WITH last_coating AS (
      SELECT invoice, MAX(event_ts) AS last_ts
      FROM job_events
      WHERE stage = 'COATING'
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM last_coating
    WHERE date(last_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(last_ts/1000, 'unixepoch', 'localtime') <  ?
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
function computeCoatingTarget(db, options) {
  const today = (options && options.today) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg   = loadConfig(db, options && options.configOverrides);

  const wip = getCoatingWIP(db);

  const intakeProjection = isWorkday(today)
    ? intakeRate(db, today, cfg.coating_intake_window_days)
    : 0;
  const capacityEstimate = capacityRate(db, today, cfg.coating_intake_window_days);

  const { rolloverIn, fromDate: rolloverFromDate, weekly: weeklyRollover } = rolloverFrom(db, today);

  const target = isWorkday(today) ? intakeProjection + rolloverIn : 0;
  const gap    = target - capacityEstimate;

  return {
    date: today,
    isWorkday: isWorkday(today),

    coatingWipCount: wip.length,

    intakeProjection,
    capacityEstimate,
    rolloverIn,
    rolloverFromDate,
    weeklyRollover,
    workdaysRemainingThisWeek: workdaysRemainingThisWeek(today),

    target,
    gap,

    formulaVersion: 1,
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
