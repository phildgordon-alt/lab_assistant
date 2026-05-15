'use strict';

/**
 * Daily picking-target computation — v1.
 *
 * Phil 2026-05-13: 6th department goal. Picking / Lens Kitchen is the
 * upstream feeder for both SV and Surfacing lines. If picking falls
 * behind, every downstream stage starves and SLAs slip.
 *
 * Formula (Phil-approved Shape C):
 *
 *   unpickedBacklog  = distinct invoices currently in the lab that
 *                      haven't been picked yet — no row in picks_history
 *                      matching their invoice AND no downstream job_events
 *                      row at any stage past PICKING.
 *   intakeProjection = 14-workday rolling avg of distinct invoices whose
 *                      first job_events.event_ts falls in window.
 *   target           = unpickedBacklog + intakeProjection   (workdays only)
 *
 * Self-correcting — no separate weekly rollover term. The backlog term
 * inherently captures yesterday's misses (any invoice that should have
 * been picked yesterday is in today's backlog automatically).
 *
 * UNIT: distinct invoices. NOT pick events. Matches every other dept
 * goal's unit. The event count (~2,200/day per warehouse) is a separate
 * operational metric on the picks-by-warehouse tile.
 */

const { classify } = require('./lens-classifier');

// ─────────────────────────────────────────────────────────────────────
// Date helpers
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
    picking_intake_window_days: 14,
    picking_rollover_layers:    1,
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
// The load-bearing query: distinct invoices in the lab, not yet picked,
// no downstream stage event. This IS the "unpicked backlog" number on
// the Picking GoalBar.
//
// "In the lab" = jobs row with entry_date or first_seen_at populated.
// "Not picked" = no row in picks_history with matching order_id AND no
//                job_events row at SURFACING / CUTTING / COATING /
//                ASSEMBLY / SHIPPING for that invoice.
//
// The downstream-stage NOT EXISTS is a safety net for picks that
// bypassed the picks_history writer (rare but documented in adapter
// notes). Without it we'd over-count jobs already at later stages.
// ─────────────────────────────────────────────────────────────────────

// Phil 2026-05-13 late: 30-day age cap excludes data-debt zombies.
// Older jobs without picks_history are almost always pre-2026-03-30
// data (when picks_history capture went live) or genuinely abandoned
// orders, not actionable picking backlog. Anything past 30 days is
// data quality, not pace.
const UNPICKED_AGE_CAP_DAYS = 30;

// Phil 2026-05-15: list and count INTENTIONALLY use different queries.
//   getUnpickedBacklog (list)       — "anything in DVI queues"
//                                     (what operators want to see)
//   getUnpickedBacklogCount (goal) — "actionable, last 30d, not yet
//                                     downstream" (what the picking
//                                     target formula consumes)
// Phil asked only for the list to reflect DVI queues; the goal stays
// on the conservative formula so today's target doesn't balloon.
const UNPICKED_STAGES = "('INCOMING','AT_KARDEX','NEL','PICKING')";

function getUnpickedBacklog(db, limit) {
  const lim = limit ? `LIMIT ${parseInt(limit, 10)}` : '';
  return db.prepare(`
    SELECT j.invoice,
           j.lens_type,
           j.current_stage,
           COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10)) AS entry_ymd,
           j.rush,
           j.frame_name
    FROM jobs j
    WHERE j.status IN ('ACTIVE','Active')
      AND j.current_stage IN ${UNPICKED_STAGES}
    ORDER BY entry_ymd ASC, j.invoice ASC
    ${lim}
  `).all();
}

function getUnpickedBacklogCount(db) {
  // ORIGINAL formula — drives picking goal. Conservative (excludes
  // stale data-debt zombies, requires no downstream-stage events).
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs j
    WHERE j.status IN ('ACTIVE','Active')
      AND (j.entry_date IS NOT NULL OR j.first_seen_at IS NOT NULL)
      AND COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10))
          >= date('now','localtime','-${UNPICKED_AGE_CAP_DAYS} days')
      AND NOT EXISTS (SELECT 1 FROM picks_history ph WHERE ph.order_id = j.invoice)
      AND NOT EXISTS (
        SELECT 1 FROM job_events je
        WHERE je.invoice = j.invoice
          AND je.stage IN ('SURFACING','CUTTING','COATING','ASSEMBLY','SHIPPING')
      )
  `).get();
  return row?.n || 0;
}

// Alias for backfill compatibility — the WIP-snapshot pattern other
// targets use. When options.wipSnapshot is provided to
// computePickingTarget, its length is used as unpickedBacklog.
function getPickingWIP(db) {
  return getUnpickedBacklog(db);
}

// ─────────────────────────────────────────────────────────────────────
// Intake / capacity counters (deterministic — pull from job_events
// and picks_history). All counts are DISTINCT INVOICES, not events.
// ─────────────────────────────────────────────────────────────────────

/**
 * Count distinct invoices whose FIRST job_events row falls in
 * [sinceYMD, untilYMD). "New work that arrived at the lab in window."
 *
 * Used by intakeRate to compute the rolling intake projection.
 */
function countPickingEntries(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    WITH first_seen AS (
      SELECT invoice, MIN(event_ts) AS first_ts
      FROM job_events
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM first_seen
    WHERE date(first_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(first_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(sinceYMD, untilYMD);
  return row?.n || 0;
}

/**
 * Count distinct invoices picked in [sinceYMD, untilYMD). PT-local day
 * boundaries. Heterogeneous completed_at timestamp format handled —
 * same logic as /api/powerpick/picks-today at oven-timer-server.js:4521.
 *
 * NO source filter (Phil's source-filter-blindspot rule): legacy rows
 * have source=NULL, current rows have source='powerpick' — counting
 * both gives the true distinct-invoice picked count.
 */
function countPickingExits(db, sinceYMD, untilYMD) {
  const row = db.prepare(`
    WITH today_picks AS (
      SELECT DISTINCT order_id
      FROM picks_history
      WHERE order_id IS NOT NULL
        AND order_id != ''
        AND (
          CASE
            WHEN completed_at LIKE '%-0%' OR completed_at LIKE '%+0%' OR completed_at LIKE '%Z'
              THEN date(completed_at, 'localtime')
            ELSE substr(completed_at, 1, 10)
          END
        ) >= ?
        AND (
          CASE
            WHEN completed_at LIKE '%-0%' OR completed_at LIKE '%+0%' OR completed_at LIKE '%Z'
              THEN date(completed_at, 'localtime')
            ELSE substr(completed_at, 1, 10)
          END
        ) < ?
    )
    SELECT COUNT(*) AS n FROM today_picks
  `).get(sinceYMD, untilYMD);
  return row?.n || 0;
}

function intakeRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const n = countPickingEntries(db, cursor, today);
  return Math.round(n / windowDays);
}

function capacityRate(db, today, windowDays) {
  let cursor = today;
  for (let i = 0; i < windowDays; i++) cursor = priorWorkday(cursor);
  const n = countPickingExits(db, cursor, today);
  return Math.round(n / windowDays);
}

// Rollover stub — picking formula folds rollover into unpickedBacklog,
// so this always returns 0. Kept for shape parity with the other
// dept-target modules so callers can treat them uniformly.
function rolloverFrom(_db, _today) {
  return { rolloverIn: 0, fromDate: null, weekly: [] };
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────

function computePickingTarget(db, options) {
  const today = (options && options.today)
    || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg = loadConfig(db, options && options.configOverrides);

  // wipSnapshot semantics: when provided (backfill replay), use its
  // length as unpickedBacklog. The backfill script's WIP reconstruction
  // returns "jobs active at historical EOD" which is a superset of
  // unpicked — the count is approximate for backfilled days, exact for
  // live (when wipSnapshot is omitted and the precise query runs).
  const unpickedBacklog = (options && options.wipSnapshot)
    ? options.wipSnapshot.length
    : getUnpickedBacklogCount(db);

  const intakeProjection = isWorkday(today)
    ? intakeRate(db, today, cfg.picking_intake_window_days)
    : 0;
  const capacityEstimate = capacityRate(db, today, cfg.picking_intake_window_days);

  // Rollover folded into backlog by design — see module header.
  const rolloverIn = 0;

  const target = isWorkday(today) ? unpickedBacklog + intakeProjection : 0;
  const gap    = target - capacityEstimate;

  return {
    date: today,
    isWorkday: isWorkday(today),

    unpickedBacklog,

    intakeProjection,
    capacityEstimate,
    rolloverIn,
    workdaysRemainingThisWeek: workdaysRemainingThisWeek(today),

    target,
    gap,

    formulaVersion: 1,
    config: {
      picking_intake_window_days: cfg.picking_intake_window_days,
      picking_rollover_layers:    cfg.picking_rollover_layers,
    },
  };
}

module.exports = {
  computePickingTarget,
  getUnpickedBacklog,
  getUnpickedBacklogCount,
  getPickingWIP,
  countPickingEntries,
  countPickingExits,
  intakeRate,
  capacityRate,
  rolloverFrom,
  isWorkday,
  priorWorkday,
  workdaysRemainingThisWeek,
  loadConfig,
};
