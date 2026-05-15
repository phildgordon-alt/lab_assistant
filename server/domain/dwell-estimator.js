'use strict';

/**
 * Empirical stage dwell-time estimator.
 *
 * Phil 2026-05-14: powers flow-time-aware target formulas (coating-target
 * v4, surfacing-target v3). Replaces the "count all upstream jobs" naïve
 * model with "how many upstream jobs CAN realistically reach the target
 * stage in the time we have left in the day, given empirical per-stage
 * dwell times measured from job_events history."
 *
 * Caches p50 + p90 per stage in `stage_dwell_stats` (migration 019).
 * Refreshed hourly by oven-timer-server.js setInterval. Stage transitions
 * are derived from `job_events` directly — for each invoice we sort
 * events by event_ts and treat the gap between consecutive events at
 * different stages as that earlier stage's dwell.
 *
 * Edge cases handled:
 *   - HOLD / BREAKAGE / CANCELED stages excluded from samples
 *   - Outliers >24h capped (matches existing `time-at-lab.js` convention)
 *   - Re-entries (rework) included as separate samples — flow forecasting
 *     should expect a reworked job to re-traverse its stages
 *   - Jobs with <2 events produce no dwell rows (naturally excluded)
 *
 * Plan: /Users/phil/.claude/plans/cheeky-wandering-hollerith.md.
 */

const WINDOW_DAYS = 14;
const OUTLIER_CAP_MIN = 1440;            // 24h — matches time-at-lab.js
const EXCLUDED_STAGES = ['HOLD','BREAKAGE','CANCELED'];

/**
 * Pull all (stage, dwell_minutes) samples for the last N days from
 * job_events. Excludes outliers and noise stages. Returns rows of
 * { stage, dwell_minutes } unsorted.
 */
function collectStageDwells(db, windowDays) {
  windowDays = windowDays || WINDOW_DAYS;
  const cutoffMs = Date.now() - (windowDays * 24 * 60 * 60 * 1000);
  // Window the events to last N days, then for each invoice walk events
  // in time order. Dwell at event[i].stage = event[i+1].event_ts - event[i].event_ts.
  // Done in two queries: pull events grouped by invoice, compute deltas
  // in JS. Simpler than SQLite window-function gymnastics.
  const rows = db.prepare(`
    SELECT invoice, stage, event_ts
    FROM job_events
    WHERE event_ts >= ?
    ORDER BY invoice, event_ts
  `).all(cutoffMs);

  const samples = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    // Walk this invoice's events
    while (j + 1 < rows.length && rows[j + 1].invoice === rows[i].invoice) j++;
    // Now rows[i..j] are this invoice's events in order
    for (let k = i; k < j; k++) {
      const cur = rows[k], nxt = rows[k + 1];
      if (!cur.stage || EXCLUDED_STAGES.includes(cur.stage)) continue;
      if (cur.stage === nxt.stage) continue;             // same stage continuation, skip
      const dwellMin = (nxt.event_ts - cur.event_ts) / 60000;
      if (dwellMin <= 0) continue;
      if (dwellMin > OUTLIER_CAP_MIN) continue;
      samples.push({ stage: cur.stage, dwell_minutes: dwellMin });
    }
    i = j + 1;
  }
  return samples;
}

/**
 * Compute p50 + p90 from a sorted-ascending number array.
 * Returns { p50, p90 } in same units as input. Empty array → nulls.
 */
function percentilesSorted(arr) {
  if (!arr.length) return { p50: null, p90: null };
  const p = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  return { p50: p(0.5), p90: p(0.9) };
}

/**
 * Recompute and persist stage_dwell_stats for the configured window.
 * Called hourly from oven-timer-server.js. Idempotent — UPSERTs.
 */
function recomputeStageDwells(db, windowDays) {
  windowDays = windowDays || WINDOW_DAYS;
  const samples = collectStageDwells(db, windowDays);

  // Group by stage
  const byStage = new Map();
  for (const s of samples) {
    if (!byStage.has(s.stage)) byStage.set(s.stage, []);
    byStage.get(s.stage).push(s.dwell_minutes);
  }

  const upsert = db.prepare(`
    INSERT INTO stage_dwell_stats (stage, window_days, sample_count, p50_minutes, p90_minutes, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(stage, window_days) DO UPDATE SET
      sample_count = excluded.sample_count,
      p50_minutes  = excluded.p50_minutes,
      p90_minutes  = excluded.p90_minutes,
      computed_at  = excluded.computed_at
  `);
  const now = Date.now();
  let written = 0;
  const tx = db.transaction(() => {
    for (const [stage, durations] of byStage) {
      durations.sort((a, b) => a - b);
      const { p50, p90 } = percentilesSorted(durations);
      upsert.run(
        stage,
        windowDays,
        durations.length,
        p50 != null ? Math.round(p50 * 10) / 10 : null,
        p90 != null ? Math.round(p90 * 10) / 10 : null,
        now,
      );
      written++;
    }
  });
  tx();
  return { stagesWritten: written, totalSamples: samples.length, computedAt: now };
}

/**
 * Read cached p50 dwell hours for a stage. Returns null if not yet computed.
 */
function getStageP50Hours(db, stage, windowDays) {
  windowDays = windowDays || WINDOW_DAYS;
  try {
    const row = db.prepare(`
      SELECT p50_minutes FROM stage_dwell_stats WHERE stage = ? AND window_days = ?
    `).get(stage, windowDays);
    if (row && row.p50_minutes != null) return row.p50_minutes / 60;
  } catch (_) { /* table not migrated yet */ }
  return null;
}

/**
 * Sum p50 dwell hours for every stage from `currentStage` (exclusive)
 * up to but not including `targetStage`. Uses STAGES_FLOW order.
 *
 * Example: estimateRemainingDwellHours(db, 'PICKING', 'COATING')
 *   = p50('SURFACING') + p50('BLOCKING')   (both ahead of COATING)
 *
 * If a stage's p50 is missing (no samples yet), uses a default fallback
 * so the formula degrades gracefully on a fresh DB.
 *
 * Phil's flow (2026-05-14): pick → surf line → dip coat (BLOCKING) →
 * oven (folds into BLOCKING/COATING dwell) → COATING dept → cut → asm.
 */
const STAGES_FLOW = [
  'INCOMING',
  'AT_KARDEX',
  'PICKING',
  'SURFACING',
  'BLOCKING',
  'COATING',
  'CUTTING',
  'ASSEMBLY',
  'QC',
  'SHIPPING',
];

// Phil 2026-05-15 correction: BLOCKING is the auto-blocker step INSIDE
// the surfacing line — ~10 min, not dip+oven. Dip-coat + oven are part
// of COATING dept (post-surfacing prep before the actual coat). So:
//   - SURFACING + BLOCKING together ≈ Phil's "surfacing line" (1–4h total)
//   - COATING includes dip-coat (1.5–2h) + oven (3h) + actual coat (~1h) ≈ 5h
const FALLBACK_DWELL_HOURS = {
  INCOMING:  1,
  AT_KARDEX: 0.5,
  PICKING:   1,
  SURFACING: 2,             // surface line minus blocking (~1-4h total split)
  BLOCKING:  0.17,          // ~10 min auto-blocker
  COATING:   5,             // dip-coat 1.5-2h + oven 3h + actual coat
  CUTTING:   1,
  ASSEMBLY:  1,
  QC:        0.5,
  SHIPPING:  0.5,
};

function estimateRemainingDwellHours(db, currentStage, targetStage) {
  const ci = STAGES_FLOW.indexOf(currentStage);
  const ti = STAGES_FLOW.indexOf(targetStage);
  if (ci < 0 || ti < 0 || ci >= ti) return 0;
  let total = 0;
  for (let k = ci + 1; k < ti; k++) {
    const stage = STAGES_FLOW[k];
    const p50 = getStageP50Hours(db, stage);
    total += (p50 != null ? p50 : (FALLBACK_DWELL_HOURS[stage] || 1));
  }
  return total;
}

/**
 * Hours remaining in the current workday in PT, given the lab's two-shift
 * model. Phil 2026-05-14: "Today is the whole day, both shifts."
 *
 * Defaults: shift starts 5 AM PT, total 16h (two 8h shifts), ends 9 PM.
 * Tunable via lab_planning_config keys `shift_start_hour`,
 * `total_shift_hours`. Outside the workday → 0. Non-workday → 0.
 */
function computeHoursLeftInWorkday(db, options) {
  const startHour = (options && options.shiftStartHour) || _readConfig(db, 'shift_start_hour', 5);
  const totalH    = (options && options.totalShiftHours) || _readConfig(db, 'total_shift_hours', 16);
  const endHour   = startHour + totalH;
  const now = options && options.now ? new Date(options.now) : new Date();
  // PT components
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const dow = parts.weekday;            // 'Mon' / 'Sat' / etc.
  if (dow === 'Sat' || dow === 'Sun') return 0;
  const h = parseInt(parts.hour, 10);
  const m = parseInt(parts.minute, 10);
  const s = parseInt(parts.second, 10);
  const nowHourFloat = h + m / 60 + s / 3600;
  if (nowHourFloat < startHour) return totalH;          // before shift start
  if (nowHourFloat >= endHour)  return 0;               // after shift end
  return Math.round((endHour - nowHourFloat) * 10) / 10;
}

function _readConfig(db, key, defaultVal) {
  try {
    const row = db.prepare(`SELECT value FROM lab_planning_config WHERE key = ?`).get(key);
    if (row && row.value != null) {
      const v = parseFloat(row.value);
      if (Number.isFinite(v)) return v;
    }
  } catch (_) { /* table not present */ }
  return defaultVal;
}

// Phil 2026-05-15: SOM-driven throughput. Real lenses-per-hour through
// each lab category, sourced from SOM `view_som_oee` and cached in the
// SOM adapter. Used by target formulas to cap "realistic arrivals today"
// at what the line can physically process.
//
// Defaults (used when SOM not connected or no data yet) — Phil's domain
// estimates: surfacing line ~150 lenses/hr, coating ~100, cutting ~140,
// assembly ~130. Tunable via lab_planning_config keys
// `throughput_default_<category>`.
const FALLBACK_THROUGHPUT_PER_HOUR = {
  surfacing: 150,
  coating:   100,
  cutting:   140,
  assembly:  130,
};

function getCategoryThroughputPerHour(db, category) {
  // First try live SOM data
  try {
    const som = require('../som-adapter');
    const cache = som.getCategoryThroughputPerHour && som.getCategoryThroughputPerHour();
    if (cache && cache[category] && cache[category] > 0) {
      return cache[category];
    }
  } catch (_) { /* SOM module unavailable on dev */ }
  // Fall back to config-tunable default
  return _readConfig(db, `throughput_default_${category}`, FALLBACK_THROUGHPUT_PER_HOUR[category] || 100);
}

module.exports = {
  recomputeStageDwells,
  getStageP50Hours,
  estimateRemainingDwellHours,
  computeHoursLeftInWorkday,
  getCategoryThroughputPerHour,
  collectStageDwells,
  percentilesSorted,
  STAGES_FLOW,
  FALLBACK_DWELL_HOURS,
  FALLBACK_THROUGHPUT_PER_HOUR,
};
