'use strict';

/**
 * Department KPI computation — single source of truth.
 *
 * Phil 2026-05-13 late: every dept landing page shows a strip of live
 * KPI tiles. Same metric, same math, same code across all surfaces
 * (capture writer, live endpoint, history overlay, audit script).
 *
 * 4 Universal KPIs per dept:
 *   1. Aging in Dept     count of current WIP whose dwell-in-dept >
 *                        threshold (default 24h)
 *   2. Max Age           hours since segment-start for the longest
 *                        currently-aging job. Drives tile color.
 *   3. Avg Dwell         mean dwell-in-dept of current WIP.
 *   4. Breakage %        count(breakage_events today, dept=code) /
 *                        count(jobs exited stage today). Goal: <2%.
 *   5. Throughput/hr     distinct invoices that exited this stage in
 *                        the last 60 min.
 *
 * Phil 2026-05-13 confirmed: dwell = CURRENT CONTIGUOUS SEGMENT only.
 * Resets every time the job leaves and re-enters. The query finds the
 * MIN event_ts where stage=DEPT AND event_ts > (last event at a
 * different stage). That's "when did THIS visit to the dept start."
 *
 * Dept-specific KPIs (1-2 per dept) live in `kpi_dept_specific` as a
 * JSON blob. Each dept's reader knows its keys; keeps the schema flat.
 *
 * Dependencies:
 *   - server/db.js  (jobs, job_events, breakage_events, picks_history)
 *   - daily-capture.js single-source-of-truth counters (count{Dept}
 *     ExitsToday) for the denominator on breakage % — reused, never
 *     re-implemented.
 */

const DEPTS = ['picking','surfacing','coating','cutting','assembly','shipping'];

// stage value in job_events, indexed by dept slug
const STAGE_BY_DEPT = {
  surfacing: 'SURFACING',
  coating:   'COATING',
  cutting:   'CUTTING',
  assembly:  'ASSEMBLY',  // station=ASSEMBLY PASS for the SOT counter; stage=ASSEMBLY for dwell
  shipping:  'SHIPPING',
  // picking is upstream of job_events — handled specially
};

// breakage_events.department single-letter code, indexed by dept slug
const BREAKAGE_CODE_BY_DEPT = {
  surfacing: 'S',
  coating:   'C',
  cutting:   'E', // Edging
  assembly:  'A',
  // picking + shipping: no breakage events in this schema
};

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

function loadKpiConfig(db) {
  const defaults = {
    kpi_aging_threshold_hours:     24,
    kpi_max_age_amber_hours:       48,
    kpi_max_age_red_hours:        120,
    kpi_breakage_pct_amber:         2,
    kpi_breakage_pct_red:           5,
    kpi_avg_dwell_amber_hours:     18,
    kpi_avg_dwell_red_hours:       36,
    kpi_throughput_window_minutes: 60,
  };
  const cfg = { ...defaults };
  try {
    const rows = db.prepare("SELECT key, value FROM lab_planning_config WHERE key LIKE 'kpi_%'").all();
    for (const r of rows) cfg[r.key] = r.value;
  } catch (_) { /* not yet migrated */ }
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────
// Dwell math — current contiguous segment per invoice.
//
// For a given stage, find each currently-active-in-dept invoice's
// segment_start: the MIN event_ts where stage=DEPT AND event_ts > any
// prior event at a different stage. If no prior different-stage event
// exists, segment_start = MIN event_ts at this stage.
//
// Returns array of { invoice, dwell_hours } for invoices whose CURRENT
// stage is the requested dept.
// ─────────────────────────────────────────────────────────────────────

function getCurrentDwellsForStage(db, stage) {
  // Three CTEs:
  //  1. active_in_dept — invoices whose jobs.current_stage = DEPT
  //  2. last_other — max event_ts for each invoice at any stage != DEPT
  //  3. segment_start — MIN event_ts at DEPT > last_other (or unconditional if no other)
  const rows = db.prepare(`
    WITH active_in_dept AS (
      SELECT invoice
      FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage = ?
    ),
    last_other AS (
      SELECT je.invoice, MAX(je.event_ts) AS last_other_ts
      FROM job_events je
      JOIN active_in_dept a ON a.invoice = je.invoice
      WHERE je.stage IS NOT NULL AND je.stage != ?
      GROUP BY je.invoice
    ),
    segment_start AS (
      SELECT je.invoice, MIN(je.event_ts) AS start_ts
      FROM job_events je
      JOIN active_in_dept a ON a.invoice = je.invoice
      LEFT JOIN last_other lo ON lo.invoice = je.invoice
      WHERE je.stage = ?
        AND (lo.last_other_ts IS NULL OR je.event_ts > lo.last_other_ts)
      GROUP BY je.invoice
    )
    SELECT ss.invoice,
           (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ss.start_ts) / 3600000.0 AS dwell_hours
    FROM segment_start ss
  `).all(stage, stage, stage);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// Picking — upstream of job_events. "Dwell in picking" = time since the
// invoice first appeared in the lab (entry_date or first_seen_at) for
// invoices that haven't been picked yet and haven't moved downstream.
// Reuses getUnpickedBacklog logic from picking-target.js.
// ─────────────────────────────────────────────────────────────────────

function getPickingDwells(db) {
  // Phil 2026-05-13 late: for the AGING tile (count of jobs over
  // threshold + max age) we measure currently-unpicked queue wait
  // time. 30-day age cap excludes zombie data debt — must match the
  // cap in picking-target.js:getUnpickedBacklog (same-count-same-math
  // -same-code rule).
  const rows = db.prepare(`
    SELECT j.invoice,
           COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10)) AS entry_ymd,
           (CAST(strftime('%s', 'now') AS INTEGER) * 1000
             - strftime('%s', COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10)) || ' 07:00:00', '+7 hours') * 1000)
             / 3600000.0 AS dwell_hours
    FROM jobs j
    WHERE j.status IN ('ACTIVE','Active')
      AND (j.entry_date IS NOT NULL OR j.first_seen_at IS NOT NULL)
      AND COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10))
          >= date('now','localtime','-30 days')
      AND NOT EXISTS (SELECT 1 FROM picks_history ph WHERE ph.order_id = j.invoice)
      AND NOT EXISTS (
        SELECT 1 FROM job_events je
        WHERE je.invoice = j.invoice
          AND je.stage IN ('SURFACING','CUTTING','COATING','ASSEMBLY','SHIPPING')
      )
  `).all();
  return rows.filter(r => Number.isFinite(r.dwell_hours) && r.dwell_hours >= 0);
}

// Phil 2026-05-13 late: "Dwell time should come from incoming jobs
// and how long they sit in the queue before they get picked." This
// is the BACKWARD-looking metric — for jobs that GOT picked recently,
// what was the average time from arrival to pick. Operational pick
// latency, capped at 30 days to filter stale entry_date data debt.
function getPickingAvgPickLatencyHours(db) {
  try {
    const row = db.prepare(`
      SELECT AVG(
        (julianday(ph.completed_at)
         - julianday(COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10)))) * 24
      ) AS avg_hours,
      COUNT(*) AS n
      FROM picks_history ph
      JOIN jobs j ON j.invoice = ph.order_id
      WHERE ph.order_id IS NOT NULL
        AND date(ph.completed_at, 'localtime') >= date('now','localtime','-7 days')
        AND COALESCE(j.entry_date, j.first_seen_at) IS NOT NULL
        AND (julianday(ph.completed_at)
             - julianday(COALESCE(j.entry_date, substr(j.first_seen_at, 1, 10))))
            BETWEEN 0 AND 30
    `).get();
    return {
      avgHours: row?.avg_hours || 0,
      sampleSize: row?.n || 0,
    };
  } catch (_) { return { avgHours: 0, sampleSize: 0 }; }
}

function dwellsForDept(db, dept) {
  if (dept === 'picking') return getPickingDwells(db);
  const stage = STAGE_BY_DEPT[dept];
  if (!stage) return [];
  return getCurrentDwellsForStage(db, stage);
}

// ─────────────────────────────────────────────────────────────────────
// Aging KPIs derived from dwells
// ─────────────────────────────────────────────────────────────────────

function computeAgingKpis(dwells, cfg) {
  const threshold = cfg.kpi_aging_threshold_hours;
  let agingCount = 0;
  let maxAge = 0;
  let sumAge = 0;
  for (const r of dwells) {
    if (r.dwell_hours > threshold) agingCount++;
    if (r.dwell_hours > maxAge) maxAge = r.dwell_hours;
    sumAge += r.dwell_hours;
  }
  const avgDwell = dwells.length > 0 ? sumAge / dwells.length : 0;
  return {
    agingCount,
    maxAgeHours: Math.round(maxAge * 10) / 10,
    avgDwellHours: Math.round(avgDwell * 10) / 10,
    wipCount: dwells.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Breakage %
// ─────────────────────────────────────────────────────────────────────

function countBreakageToday(db, dept, ymd) {
  const code = BREAKAGE_CODE_BY_DEPT[dept];
  if (!code) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM breakage_events
      WHERE department = ?
        AND date(occurred_at, 'localtime') = ?
    `).get(code, ymd);
    return row?.n || 0;
  } catch (_) {
    return 0; // table may not exist on a fresh dev DB
  }
}

function computeBreakageKpi(db, dept, ymd, exitedTodayCount) {
  const breakageCount = countBreakageToday(db, dept, ymd);
  const pct = exitedTodayCount > 0
    ? Math.round((breakageCount / exitedTodayCount) * 10000) / 100
    : 0;
  return { breakageCount, breakagePct: pct };
}

// ─────────────────────────────────────────────────────────────────────
// Throughput per hour — distinct invoices that finished the stage in
// the rolling window (default 60 min). "Finished the stage" = last
// event at this stage for the invoice within the window AND the
// invoice has subsequently moved to a different stage (i.e., genuinely
// exited, not currently in-progress). Falls back to "any event at this
// stage in window" if the subsequent-stage requirement filters too
// aggressively on dev with sparse data.
// ─────────────────────────────────────────────────────────────────────

function computeThroughputPerHour(db, dept, cfg) {
  if (dept === 'picking') {
    // Picking throughput = distinct invoices picked in window from picks_history
    const windowMin = cfg.kpi_throughput_window_minutes;
    try {
      const row = db.prepare(`
        SELECT COUNT(DISTINCT order_id) AS n
        FROM picks_history
        WHERE order_id IS NOT NULL AND order_id != ''
          AND (
            CASE
              WHEN completed_at LIKE '%-0%' OR completed_at LIKE '%+0%' OR completed_at LIKE '%Z'
                THEN strftime('%s', completed_at) * 1000
              ELSE strftime('%s', completed_at) * 1000
            END
          ) >= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - (? * 60 * 1000)
      `).get(windowMin);
      const n = row?.n || 0;
      return Math.round((n / (windowMin / 60)) * 10) / 10; // events/hr (n already in window-hours)
    } catch (_) { return 0; }
  }
  const stage = STAGE_BY_DEPT[dept];
  if (!stage) return 0;
  const windowMs = cfg.kpi_throughput_window_minutes * 60 * 1000;
  // Distinct invoices whose MAX(event_ts) at this stage falls in the window
  // AND whose subsequent event is at a different stage (i.e. truly exited).
  // For shipping (terminal), drop the subsequent-stage requirement.
  const requireSubsequent = stage !== 'SHIPPING';
  if (!requireSubsequent) {
    const row = db.prepare(`
      WITH last_at_stage AS (
        SELECT invoice, MAX(event_ts) AS last_ts
        FROM job_events
        WHERE stage = ?
        GROUP BY invoice
      )
      SELECT COUNT(*) AS n
      FROM last_at_stage
      WHERE last_ts >= CAST(strftime('%s','now') AS INTEGER) * 1000 - ?
    `).get(stage, windowMs);
    const n = row?.n || 0;
    return Math.round((n / (cfg.kpi_throughput_window_minutes / 60)) * 10) / 10;
  }
  const row = db.prepare(`
    WITH last_at_stage AS (
      SELECT invoice, MAX(event_ts) AS last_ts
      FROM job_events
      WHERE stage = ?
      GROUP BY invoice
    ),
    has_after AS (
      SELECT las.invoice
      FROM last_at_stage las
      WHERE EXISTS (
        SELECT 1 FROM job_events je2
        WHERE je2.invoice = las.invoice
          AND je2.event_ts > las.last_ts
          AND je2.stage != ?
      )
      AND las.last_ts >= CAST(strftime('%s','now') AS INTEGER) * 1000 - ?
    )
    SELECT COUNT(*) AS n FROM has_after
  `).get(stage, stage, windowMs);
  const n = row?.n || 0;
  return Math.round((n / (cfg.kpi_throughput_window_minutes / 60)) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────
// Dept-specific KPIs (1-2 per dept). Returned as a flat object that
// captureDailyDeptKpis JSON-stringifies into kpi_dept_specific.
//
// First-iteration scope: the easy ones from existing data. SOM-dependent
// metrics (generators-active, batch-fill from coaters, active edgers)
// can be added later by extending these per-dept functions.
// ─────────────────────────────────────────────────────────────────────

function deptSpecificForPicking(db) {
  try {
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs j
      WHERE j.status IN ('ACTIVE','Active')
        AND (j.entry_date IS NOT NULL OR j.first_seen_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM picks_history ph WHERE ph.order_id = j.invoice)
        AND NOT EXISTS (SELECT 1 FROM job_events je
                         WHERE je.invoice = j.invoice
                           AND je.stage IN ('SURFACING','CUTTING','COATING','ASSEMBLY','SHIPPING'))
    `).get()?.n || 0;
    const rush = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs j
      WHERE j.status IN ('ACTIVE','Active') AND j.rush = 'Y'
        AND NOT EXISTS (SELECT 1 FROM picks_history ph WHERE ph.order_id = j.invoice)
        AND NOT EXISTS (SELECT 1 FROM job_events je
                         WHERE je.invoice = j.invoice
                           AND je.stage IN ('SURFACING','CUTTING','COATING','ASSEMBLY','SHIPPING'))
    `).get()?.n || 0;
    return { backlog: total, rush };
  } catch (_) { return { backlog: 0, rush: 0 }; }
}

function deptSpecificForAssembly(db, ymd) {
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN station = 'ASSEMBLY PASS' THEN 1 ELSE 0 END) AS passes,
        SUM(CASE WHEN station = 'ASSEMBLY FAIL' THEN 1 ELSE 0 END) AS fails
      FROM job_events
      WHERE date(event_ts/1000, 'unixepoch', 'localtime') = ?
        AND station IN ('ASSEMBLY PASS','ASSEMBLY FAIL')
    `).get(ymd);
    const passes = row?.passes || 0;
    const fails  = row?.fails  || 0;
    const passRate = (passes + fails) > 0
      ? Math.round((passes / (passes + fails)) * 1000) / 10
      : 0;
    const stationsActive = db.prepare(`
      SELECT COUNT(DISTINCT station) AS n FROM job_events
      WHERE station LIKE 'ASSEMBLY %'
        AND event_ts >= CAST(strftime('%s','now') AS INTEGER) * 1000 - 3600000
    `).get()?.n || 0;
    return { passRate, stationsActive };
  } catch (_) { return { passRate: 0, stationsActive: 0 }; }
}

function deptSpecificForShipping(db) {
  try {
    const ready = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage = 'SHIPPING'
        AND (ship_date IS NULL OR ship_date = '')
    `).get()?.n || 0;
    const rushReady = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE status IN ('ACTIVE','Active')
        AND current_stage = 'SHIPPING'
        AND (ship_date IS NULL OR ship_date = '')
        AND rush = 'Y'
    `).get()?.n || 0;
    return { readyToShip: ready, rushInQueue: rushReady };
  } catch (_) { return { readyToShip: 0, rushInQueue: 0 }; }
}

function deptSpecificForSurfacing(db, breakageCount, dwells) {
  // Block rate stub: % of WIP that has been here >2d (suggests blocking)
  const blockRate = dwells.length > 0
    ? Math.round((dwells.filter(d => d.dwell_hours > 48).length / dwells.length) * 1000) / 10
    : 0;
  return { generatorsActive: null, blockRate };  // generatorsActive: SOM-dep, deferred
}

function deptSpecificForCoating(db) {
  // Active batches stub. Real batch-fill needs SOM coaters table — deferred.
  try {
    const inCoating = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE status IN ('ACTIVE','Active') AND current_stage = 'COATING'
    `).get()?.n || 0;
    return { activeBatches: null, inCoatingWip: inCoating };
  } catch (_) { return { activeBatches: null, inCoatingWip: 0 }; }
}

function deptSpecificForCutting(db) {
  try {
    const inCutting = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE status IN ('ACTIVE','Active') AND current_stage = 'CUTTING'
    `).get()?.n || 0;
    return { activeEdgers: null, inCuttingWip: inCutting };
  } catch (_) { return { activeEdgers: null, inCuttingWip: 0 }; }
}

function deptSpecific(db, dept, ymd, dwells, breakageCount) {
  switch (dept) {
    case 'picking':   return deptSpecificForPicking(db);
    case 'surfacing': return deptSpecificForSurfacing(db, breakageCount, dwells);
    case 'coating':   return deptSpecificForCoating(db);
    case 'cutting':   return deptSpecificForCutting(db);
    case 'assembly':  return deptSpecificForAssembly(db, ymd);
    case 'shipping':  return deptSpecificForShipping(db);
    default:          return {};
  }
}

// ─────────────────────────────────────────────────────────────────────
// Daily exit count (denominator for breakage %) — reuses existing SOTs.
// ─────────────────────────────────────────────────────────────────────

function exitedTodayCount(db, dept, ymd) {
  // Direct query for shipping — same SQL getShippedCounts uses. Don't
  // require('../oven-timer-server') here: it would trigger boot-time
  // setTimeouts/setIntervals on every dept-kpis call.
  if (dept === 'shipping') {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM dvi_shipped_jobs
        WHERE is_hko = 0 AND ship_date = ?
      `).get(ymd);
      return row?.n || 0;
    } catch (_) { return 0; }
  }
  if (dept === 'coating') {
    const { countCoatingExits } = require('./coating-target');
    const tomorrow = nextDayYMD(ymd);
    return countCoatingExits(db, ymd, tomorrow);
  }
  if (dept === 'surfacing') {
    const { countSurfacingExitsToday } = require('./daily-capture');
    return countSurfacingExitsToday(db, ymd);
  }
  if (dept === 'cutting') {
    const { countCuttingExitsToday } = require('./daily-capture');
    return countCuttingExitsToday(db, ymd);
  }
  if (dept === 'assembly') {
    const { countAssemblyToday } = require('./daily-capture');
    return countAssemblyToday(db, ymd);
  }
  if (dept === 'picking') {
    const { countPickingExitsToday } = require('./daily-capture');
    return countPickingExitsToday(db, ymd);
  }
  return 0;
}

function nextDayYMD(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point — compute all KPIs for a dept.
// ─────────────────────────────────────────────────────────────────────

function computeDeptKpis(db, dept, options) {
  if (!DEPTS.includes(dept)) {
    throw new Error(`Unknown dept: ${dept}. Must be one of: ${DEPTS.join(', ')}`);
  }
  const ymd = (options && options.today)
    || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const cfg = loadKpiConfig(db);

  const dwells = dwellsForDept(db, dept);
  const aging = computeAgingKpis(dwells, cfg);
  const exited = exitedTodayCount(db, dept, ymd);
  const breakage = computeBreakageKpi(db, dept, ymd, exited);
  const throughputPerHour = computeThroughputPerHour(db, dept, cfg);
  const specific = deptSpecific(db, dept, ymd, dwells, breakage.breakageCount);

  // Phil 2026-05-13 late: picking's "avg dwell" is operationally the
  // average pick-latency — time from job arriving to job getting picked
  // — measured over jobs picked in the last 7 days. Override the
  // currently-waiting-queue avg with the historical-pick-latency avg.
  // The currently-waiting cohort still drives Aging (count over
  // threshold) + Max Age (oldest in queue) — same data, two metrics.
  if (dept === 'picking') {
    const latency = getPickingAvgPickLatencyHours(db);
    aging.avgDwellHours = Math.round(latency.avgHours * 10) / 10;
    // Surface sample size in deptSpecific so the tile sub-line can
    // show "avg over N picked / 7d" if we wire it later.
    if (specific && typeof specific === 'object') {
      specific.pickLatencySampleSize = latency.sampleSize;
    }
  }

  return {
    dept,
    date: ymd,
    kpis: {
      agingCount:        aging.agingCount,
      maxAgeHours:       aging.maxAgeHours,
      avgDwellHours:     aging.avgDwellHours,
      wipCount:          aging.wipCount,
      breakagePct:       breakage.breakagePct,
      breakageCount:     breakage.breakageCount,
      throughputPerHour,
      exitedToday:       exited,
      deptSpecific:      specific,
    },
    thresholds: {
      agingHours:        cfg.kpi_aging_threshold_hours,
      maxAgeAmberHours:  cfg.kpi_max_age_amber_hours,
      maxAgeRedHours:    cfg.kpi_max_age_red_hours,
      breakagePctAmber:  cfg.kpi_breakage_pct_amber,
      breakagePctRed:    cfg.kpi_breakage_pct_red,
      avgDwellAmberHours: cfg.kpi_avg_dwell_amber_hours,
      avgDwellRedHours:  cfg.kpi_avg_dwell_red_hours,
    },
  };
}

module.exports = {
  computeDeptKpis,
  countBreakageToday,
  dwellsForDept,
  loadKpiConfig,
  DEPTS,
  STAGE_BY_DEPT,
  BREAKAGE_CODE_BY_DEPT,
};
