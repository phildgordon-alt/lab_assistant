-- 011_coating_target_v1.sql
--
-- Coating throughput target — single-number daily goal mirroring the
-- shipping target but without customer-SLA escalation. Coating is a pure
-- throughput stage (no contractual deadline per job), so the formula
-- collapses to:
--
--   intakeFloor = 14-workday rolling avg of jobs entering COATING per day
--   rolloverIn  = sum(target - coated) for prior workdays this week
--   target      = intakeFloor + rolloverIn
--
-- Rollover resets each Monday, matching ship-target.js convention. The
-- table captures the same signal-column trend data so the planning module
-- can pattern-match coating vs shipping over time.

CREATE TABLE IF NOT EXISTS daily_coating_targets (
  date                TEXT PRIMARY KEY,
  is_workday          INTEGER DEFAULT 1,
  coating_wip         INTEGER DEFAULT 0,
  intake_projection   INTEGER DEFAULT 0,
  capacity_estimate   INTEGER DEFAULT 0,
  rollover_in         INTEGER DEFAULT 0,
  total_target        INTEGER DEFAULT 0,
  coated_actual       INTEGER DEFAULT 0,
  variance            INTEGER DEFAULT 0,
  formula_version     INTEGER DEFAULT 1,
  captured_at         TEXT DEFAULT (datetime('now')),
  finalized_at        TEXT
);

-- Coating-specific tunables in the shared planning config table.
-- intake_window_days deliberately mirrors the shipping default — same
-- rolling-avg window keeps both signals comparable.
INSERT OR IGNORE INTO lab_planning_config (key, value, description) VALUES
  ('coating_intake_window_days', 14.0, 'Rolling window (workdays) for coating intake projection. 14 = ~3 weeks. Mirrors shipping intake_window_days for cross-stage trend comparison.'),
  ('coating_rollover_layers',    1.0,  'How many prior-workday misses to roll into today for coating. 1 = yesterday only.'),
  ('coating_formula_version',    1.0,  'Active coating target formula version. 1 = intake + rollover (current).');
