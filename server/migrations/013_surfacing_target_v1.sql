-- 013_surfacing_target_v1.sql
--
-- Phil 2026-05-13 evening: surfacing is the upstream master throughput
-- target — everything that ships had to surface first. Previously the
-- /api/surfacing/target endpoint returned `computeCoatingTarget().target`
-- as a stopgap (the "everything surfaced goes into coating" rule),
-- producing 409 today vs ~1,200 actual surfacing throughput. Phil
-- reversed that decision: surfacing gets its own first-class target,
-- coating remains a subset (lenses that need coating).
--
-- The formula mirrors coating-target.js's shape — pure throughput stage,
-- no customer-SLA escalation, single-number daily goal:
--
--   intakeProjection = 14-workday rolling avg of distinct invoices
--                      whose first SURFACING stage event was within
--                      the window
--   rolloverIn       = sum(target - surfaced_actual) for prior workdays
--                      this week, clamped >= 0
--   target           = intakeProjection + rolloverIn
--
-- Rollover resets each Monday. The table captures the same signal-
-- column trend data so planning module can pattern-match surfacing vs
-- coating vs shipping over time.
--
-- Note: countSurfacingExitsToday in domain/daily-capture.js was
-- redefined 2026-05-13 to mean "last SURFACING event today" (Phil's
-- "completed surfacing today" semantic). This migration uses that same
-- definition for surfaced_actual — same count, same math, same code
-- across writers.

CREATE TABLE IF NOT EXISTS daily_surfacing_targets (
  date                TEXT PRIMARY KEY,
  is_workday          INTEGER DEFAULT 1,
  surfacing_wip       INTEGER DEFAULT 0,
  intake_projection   INTEGER DEFAULT 0,
  capacity_estimate   INTEGER DEFAULT 0,
  rollover_in         INTEGER DEFAULT 0,
  total_target        INTEGER DEFAULT 0,
  surfaced_actual     INTEGER DEFAULT 0,
  variance            INTEGER DEFAULT 0,
  formula_version     INTEGER DEFAULT 1,
  captured_at         TEXT DEFAULT (datetime('now')),
  finalized_at        TEXT
);

-- Surfacing-specific tunables in the shared planning config table.
-- intake_window_days mirrors shipping + coating defaults for cross-
-- stage trend comparability.
INSERT OR IGNORE INTO lab_planning_config (key, value, description) VALUES
  ('surfacing_intake_window_days', 14.0, 'Rolling window (workdays) for surfacing intake projection. 14 = ~3 weeks. Mirrors shipping/coating intake_window_days for cross-stage trend comparison.'),
  ('surfacing_rollover_layers',    1.0,  'How many prior-workday misses to roll into today for surfacing. 1 = current week only.'),
  ('surfacing_formula_version',    1.0,  'Active surfacing target formula version. 1 = intake + rollover (current).');
