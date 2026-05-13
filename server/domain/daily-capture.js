'use strict';

/**
 * Daily-capture writers for goal-vs-actual history.
 *
 * Shipping has its own writer at oven-timer-server.js:captureDailyShipTarget,
 * which fills daily_ship_targets. This module fills the rest:
 *
 *   - captureDailyCoatingTarget(db)
 *     Calls computeCoatingTarget(db) and countCoatingExits(db, today, tomorrow)
 *     and UPSERTs daily_coating_targets. Table exists from migration 011 but
 *     the writer didn't until 2026-05-13.
 *
 *   - captureDailyDeptActuals(db)
 *     Single function, both depts (assembly + cutting). Counts today's events
 *     from job_events and UPSERTs daily_dept_actuals. Targets come from
 *     daily_ship_targets at query time (cutting + assembly = ship target).
 *
 * All writers:
 *   - PT-local date key (matches captureDailyShipTarget convention)
 *   - UPSERT — safe to call repeatedly during a day; actual updates as work
 *     finishes
 *   - Finalize after 23h PT — sets finalized_at to freeze the day's number
 *   - Never throw — failures are logged and ignored, the next call retries
 *
 * Phil 2026-05-13: each department landing page needs Goal vs Actual
 * history written to DB (not computed live on every request).
 */

const { computeCoatingTarget, countCoatingExits } = require('./coating-target');
const { computeSurfacingTarget } = require('./surfacing-target');
const { computePickingTarget, countPickingExits } = require('./picking-target');
const { computeDeptKpis } = require('./dept-kpis');

/**
 * Helper — PT-local date parts. Mirrors the labLocalParts() pattern in
 * oven-timer-server.js but contained here so this module is self-sufficient.
 */
function ptLocalParts(date) {
  const d = date || new Date();
  // Anglo-Saxon-friendly: 'en-CA' formats YYYY-MM-DD in the local TZ.
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const ptHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(d),
    10
  );
  // dow: 0=Sun ... 6=Sat in PT
  const ptDow = new Date(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  ).getDay();
  return { ymd, ptHour, ptDow };
}

function nextDayYMD(ymd) {
  // Add a day to YYYY-MM-DD in PT terms.
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Coating capture
// ─────────────────────────────────────────────────────────────────────────────

function captureDailyCoatingTarget(db) {
  try {
    const { ymd, ptHour, ptDow } = ptLocalParts();
    const tomorrow = nextDayYMD(ymd);
    const isWorkday = ptDow >= 1 && ptDow <= 5 ? 1 : 0;

    const target = computeCoatingTarget(db);
    const coatedActual = countCoatingExits(db, ymd, tomorrow);
    const variance = coatedActual - (target.target || 0);

    const existing = db.prepare('SELECT date FROM daily_coating_targets WHERE date = ?').get(ymd);
    if (existing) {
      db.prepare(`
        UPDATE daily_coating_targets
        SET coating_wip = ?, intake_projection = ?, capacity_estimate = ?,
            rollover_in = ?, total_target = ?, coated_actual = ?, variance = ?
        WHERE date = ?
      `).run(
        target.coatingWipCount || 0,
        target.intakeProjection || 0,
        target.capacityEstimate || 0,
        target.rolloverIn || 0,
        target.target || 0,
        coatedActual,
        variance,
        ymd
      );
    } else {
      db.prepare(`
        INSERT INTO daily_coating_targets
        (date, is_workday, coating_wip, intake_projection, capacity_estimate,
         rollover_in, total_target, coated_actual, variance, formula_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ymd, isWorkday,
        target.coatingWipCount || 0,
        target.intakeProjection || 0,
        target.capacityEstimate || 0,
        target.rolloverIn || 0,
        target.target || 0,
        coatedActual,
        variance,
        target.formulaVersion || 1
      );
      console.log(`[CoatingTarget] Captured ${ymd}: target=${target.target}, coated=${coatedActual}`);
    }

    if (ptHour >= 23) {
      const yesterday = nextDayYMD(ymd.split('-').slice(0, 3).join('-')); // placeholder fix below
      // (Use yesterday = day before today)
      const y = new Date(ymd + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      const yYmd = y.toISOString().slice(0, 10);
      db.prepare(`
        UPDATE daily_coating_targets
        SET finalized_at = datetime('now')
        WHERE date = ? AND finalized_at IS NULL
      `).run(yYmd);
    }
  } catch (e) {
    console.error('[CoatingTarget] capture failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Surfacing capture (Phil 2026-05-13: surfacing is the upstream master
// throughput target; previously its endpoint returned coating's number)
// ─────────────────────────────────────────────────────────────────────────────

function captureDailySurfacingTarget(db) {
  try {
    const { ymd, ptHour, ptDow } = ptLocalParts();
    const isWorkday = ptDow >= 1 && ptDow <= 5 ? 1 : 0;

    const target = computeSurfacingTarget(db);
    // surfaced_actual matches countSurfacingExitsToday — "last SURFACING
    // event today" — same source as captureDailyDeptActuals writes for
    // daily_dept_actuals.dept='surfacing'. Single rule, no drift.
    const surfacedActual = countSurfacingExitsToday(db, ymd);
    const variance = surfacedActual - (target.target || 0);

    const existing = db.prepare('SELECT date FROM daily_surfacing_targets WHERE date = ?').get(ymd);
    if (existing) {
      db.prepare(`
        UPDATE daily_surfacing_targets
        SET surfacing_wip = ?, intake_projection = ?, capacity_estimate = ?,
            rollover_in = ?, total_target = ?, surfaced_actual = ?, variance = ?
        WHERE date = ?
      `).run(
        target.surfacingWipCount || 0,
        target.intakeProjection || 0,
        target.capacityEstimate || 0,
        target.rolloverIn || 0,
        target.target || 0,
        surfacedActual,
        variance,
        ymd
      );
    } else {
      db.prepare(`
        INSERT INTO daily_surfacing_targets
        (date, is_workday, surfacing_wip, intake_projection, capacity_estimate,
         rollover_in, total_target, surfaced_actual, variance, formula_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ymd, isWorkday,
        target.surfacingWipCount || 0,
        target.intakeProjection || 0,
        target.capacityEstimate || 0,
        target.rolloverIn || 0,
        target.target || 0,
        surfacedActual,
        variance,
        target.formulaVersion || 1
      );
      console.log(`[SurfacingTarget] Captured ${ymd}: target=${target.target}, surfaced=${surfacedActual}`);
    }

    if (ptHour >= 23) {
      const y = new Date(ymd + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      const yYmd = y.toISOString().slice(0, 10);
      db.prepare(`
        UPDATE daily_surfacing_targets
        SET finalized_at = datetime('now')
        WHERE date = ? AND finalized_at IS NULL
      `).run(yYmd);
    }
  } catch (e) {
    console.error('[SurfacingTarget] capture failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Picking capture (Phil 2026-05-13: 6th dept goal — Picking / Lens Kitchen)
// ─────────────────────────────────────────────────────────────────────────────

// Single source of truth — every consumer of "picks today" calls this.
function countPickingExitsToday(db, ymd) {
  const tomorrow = nextDayYMD(ymd);
  return countPickingExits(db, ymd, tomorrow);
}

function captureDailyPickingTarget(db) {
  try {
    const { ymd, ptHour, ptDow } = ptLocalParts();
    const isWorkday = ptDow >= 1 && ptDow <= 5 ? 1 : 0;

    const target = computePickingTarget(db);
    const pickedActual = countPickingExitsToday(db, ymd);
    const variance = pickedActual - (target.target || 0);

    const existing = db.prepare('SELECT date FROM daily_picking_targets WHERE date = ?').get(ymd);
    if (existing) {
      db.prepare(`
        UPDATE daily_picking_targets
        SET unpicked_backlog = ?, intake_projection = ?, capacity_estimate = ?,
            rollover_in = ?, total_target = ?, picked_actual = ?, variance = ?
        WHERE date = ?
      `).run(
        target.unpickedBacklog || 0,
        target.intakeProjection || 0,
        target.capacityEstimate || 0,
        target.rolloverIn || 0,
        target.target || 0,
        pickedActual,
        variance,
        ymd
      );
    } else {
      db.prepare(`
        INSERT INTO daily_picking_targets
        (date, is_workday, unpicked_backlog, intake_projection, capacity_estimate,
         rollover_in, total_target, picked_actual, variance, formula_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ymd, isWorkday,
        target.unpickedBacklog || 0,
        target.intakeProjection || 0,
        target.capacityEstimate || 0,
        target.rolloverIn || 0,
        target.target || 0,
        pickedActual,
        variance,
        target.formulaVersion || 1
      );
      console.log(`[PickingTarget] Captured ${ymd}: target=${target.target} (backlog=${target.unpickedBacklog} + intake=${target.intakeProjection}), picked=${pickedActual}`);
    }

    if (ptHour >= 23) {
      const y = new Date(ymd + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      const yYmd = y.toISOString().slice(0, 10);
      db.prepare(`
        UPDATE daily_picking_targets
        SET finalized_at = datetime('now')
        WHERE date = ? AND finalized_at IS NULL
      `).run(yYmd);
    }
  } catch (e) {
    console.error('[PickingTarget] capture failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly + Cutting actuals capture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Cutting actual" = distinct invoices that exited CUTTING today (per Phil's
 * 2026-05-12 confirmation: mirrors coating's exits convention).
 *
 * "Assembly actual" = distinct invoices with an ASSEMBLY-station event today.
 * Matches the count rule already used by /api/assembly/jobs.
 */

// Phil 2026-05-13: "passed at assembly today." Assembly actual = distinct
// invoices with an 'ASSEMBLY PASS' station event today. Previously this
// counted any 'ASSEMBLY #%' station touch — that's broader (includes WIP
// at an assembly station) than "passed." Align on Phil's definition.
function countAssemblyToday(db, ymd) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT invoice) AS n
    FROM job_events
    WHERE station = 'ASSEMBLY PASS'
      AND date(event_ts/1000, 'unixepoch', 'localtime') = ?
  `).get(ymd);
  return row?.n || 0;
}

// Phil 2026-05-13: redefined as "last stage event today" (matches
// countCoatingExits in coating-target.js). Old definition undercounted by
// ~100× because it required the first post-stage event to be today; the
// new definition matches "completed surfacing/cutting today" as spoken.
// See countCoatingExits docstring for full rationale.
function countSurfacingExitsToday(db, ymd) {
  const tomorrow = nextDayYMD(ymd);
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
  `).get(ymd, tomorrow);
  return row?.n || 0;
}

function countCuttingExitsToday(db, ymd) {
  const tomorrow = nextDayYMD(ymd);
  const row = db.prepare(`
    WITH last_cutting AS (
      SELECT invoice, MAX(event_ts) AS last_ts
      FROM job_events
      WHERE stage = 'CUTTING'
      GROUP BY invoice
    )
    SELECT COUNT(*) AS n
    FROM last_cutting
    WHERE date(last_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(last_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(ymd, tomorrow);
  return row?.n || 0;
}

function captureDailyDeptActuals(db) {
  try {
    const { ymd, ptHour } = ptLocalParts();
    const assemblyActual = countAssemblyToday(db, ymd);
    const cuttingActual = countCuttingExitsToday(db, ymd);
    const surfacingActual = countSurfacingExitsToday(db, ymd);

    const upsert = db.prepare(`
      INSERT INTO daily_dept_actuals (date, dept, actual)
      VALUES (?, ?, ?)
      ON CONFLICT(date, dept) DO UPDATE SET actual = excluded.actual,
                                            captured_at = datetime('now')
    `);
    upsert.run(ymd, 'assembly', assemblyActual);
    upsert.run(ymd, 'cutting', cuttingActual);
    upsert.run(ymd, 'surfacing', surfacingActual);

    if (ptHour >= 23) {
      const y = new Date(ymd + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      const yYmd = y.toISOString().slice(0, 10);
      db.prepare(`
        UPDATE daily_dept_actuals
        SET finalized_at = datetime('now')
        WHERE date = ? AND finalized_at IS NULL
      `).run(yYmd);
    }
  } catch (e) {
    console.error('[DeptActuals] capture failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dept KPIs capture — Phil 2026-05-13 late: fans out across all 6 depts,
// calls computeDeptKpis (single source of truth) for each, UPSERTs the
// snapshot into the right table (target table for picking/coating/
// surfacing/shipping; dedicated KPI tables for assembly + cutting).
// ─────────────────────────────────────────────────────────────────────────────

const KPI_TABLE_BY_DEPT = {
  shipping:  'daily_ship_targets',
  coating:   'daily_coating_targets',
  surfacing: 'daily_surfacing_targets',
  picking:   'daily_picking_targets',
  assembly:  'daily_assembly_kpis',
  cutting:   'daily_cutting_kpis',
};

function captureDailyDeptKpis(db) {
  const { ymd } = ptLocalParts();
  for (const dept of ['picking','surfacing','coating','cutting','assembly','shipping']) {
    try {
      const result = computeDeptKpis(db, dept, { today: ymd });
      const k = result.kpis;
      const tbl = KPI_TABLE_BY_DEPT[dept];

      // Use direct ALTER-added columns; assembly+cutting use the dedicated
      // tables that have the same column shape. UPSERT on `date` PK.
      // Two table shapes:
      //   - target tables (4 of them): have many other columns (target,
      //     actual, variance, etc.) so the UPSERT clauses only touch the
      //     KPI columns.
      //   - dedicated KPI tables (assembly+cutting): only KPI columns.
      // SQL is the same UPSERT either way — INSERT defaults the other
      // columns to 0 on first write; UPDATE only touches KPI columns.
      const targetTables = ['daily_ship_targets','daily_coating_targets','daily_surfacing_targets','daily_picking_targets'];
      if (targetTables.includes(tbl)) {
        // For target tables, ensure a row exists for today first (created
        // by the dept's own target writer); just UPDATE KPI columns.
        const exists = db.prepare(`SELECT date FROM ${tbl} WHERE date = ?`).get(ymd);
        if (exists) {
          db.prepare(`
            UPDATE ${tbl}
            SET kpi_aging_count = ?, kpi_max_age_hours = ?, kpi_avg_dwell_hours = ?,
                kpi_breakage_pct = ?, kpi_breakage_count = ?, kpi_throughput_per_hour = ?,
                kpi_dept_specific = ?
            WHERE date = ?
          `).run(
            k.agingCount, k.maxAgeHours, k.avgDwellHours,
            k.breakagePct, k.breakageCount, k.throughputPerHour,
            JSON.stringify(k.deptSpecific || {}),
            ymd
          );
        }
        // If target row doesn't exist yet, the dept's target writer
        // hasn't fired — KPIs will be captured on the next pass after
        // that writer creates the row. Acceptable; capture is hourly
        // and skewed by 15s offsets so target writers run first.
      } else {
        // Dedicated KPI tables — UPSERT with all columns.
        const exists = db.prepare(`SELECT date FROM ${tbl} WHERE date = ?`).get(ymd);
        if (exists) {
          db.prepare(`
            UPDATE ${tbl}
            SET kpi_aging_count = ?, kpi_max_age_hours = ?, kpi_avg_dwell_hours = ?,
                kpi_breakage_pct = ?, kpi_breakage_count = ?, kpi_throughput_per_hour = ?,
                kpi_dept_specific = ?
            WHERE date = ?
          `).run(
            k.agingCount, k.maxAgeHours, k.avgDwellHours,
            k.breakagePct, k.breakageCount, k.throughputPerHour,
            JSON.stringify(k.deptSpecific || {}),
            ymd
          );
        } else {
          db.prepare(`
            INSERT INTO ${tbl}
            (date, kpi_aging_count, kpi_max_age_hours, kpi_avg_dwell_hours,
             kpi_breakage_pct, kpi_breakage_count, kpi_throughput_per_hour,
             kpi_dept_specific)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            ymd,
            k.agingCount, k.maxAgeHours, k.avgDwellHours,
            k.breakagePct, k.breakageCount, k.throughputPerHour,
            JSON.stringify(k.deptSpecific || {})
          );
        }
      }
    } catch (e) {
      console.error(`[DeptKpis] ${dept} capture failed:`, e.message);
    }
  }
}

module.exports = {
  captureDailyCoatingTarget,
  captureDailySurfacingTarget,
  captureDailyPickingTarget,
  captureDailyDeptActuals,
  captureDailyDeptKpis,
  countAssemblyToday,
  countCuttingExitsToday,
  countSurfacingExitsToday,
  countPickingExitsToday,
};
