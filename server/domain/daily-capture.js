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
// Assembly + Cutting actuals capture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Cutting actual" = distinct invoices that exited CUTTING today (per Phil's
 * 2026-05-12 confirmation: mirrors coating's exits convention).
 *
 * "Assembly actual" = distinct invoices with an ASSEMBLY-station event today.
 * Matches the count rule already used by /api/assembly/jobs.
 */

function countAssemblyToday(db, ymd) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT invoice) AS n
    FROM job_events
    WHERE station LIKE 'ASSEMBLY #%'
      AND date(event_ts/1000, 'unixepoch', 'localtime') = ?
  `).get(ymd);
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
    ),
    exited AS (
      SELECT je.invoice, MIN(je.event_ts) AS exit_ts
      FROM job_events je
      JOIN last_cutting lc ON lc.invoice = je.invoice
      WHERE je.stage NOT IN ('CUTTING','HOLD','CANCELED')
        AND je.event_ts > lc.last_ts
      GROUP BY je.invoice
    )
    SELECT COUNT(*) AS n
    FROM exited
    WHERE date(exit_ts/1000, 'unixepoch', 'localtime') >= ?
      AND date(exit_ts/1000, 'unixepoch', 'localtime') <  ?
  `).get(ymd, tomorrow);
  return row?.n || 0;
}

function captureDailyDeptActuals(db) {
  try {
    const { ymd, ptHour } = ptLocalParts();
    const assemblyActual = countAssemblyToday(db, ymd);
    const cuttingActual = countCuttingExitsToday(db, ymd);

    const upsert = db.prepare(`
      INSERT INTO daily_dept_actuals (date, dept, actual)
      VALUES (?, ?, ?)
      ON CONFLICT(date, dept) DO UPDATE SET actual = excluded.actual,
                                            captured_at = datetime('now')
    `);
    upsert.run(ymd, 'assembly', assemblyActual);
    upsert.run(ymd, 'cutting', cuttingActual);

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

module.exports = {
  captureDailyCoatingTarget,
  captureDailyDeptActuals,
  countAssemblyToday,
  countCuttingExitsToday,
};
