-- 009_ship_target_v2.sql
--
-- Extends daily_ship_targets to support the v2 priority-weighted ship
-- target formula and adds a tunable-config table for the planning
-- module that will follow.
--
-- v2 formula (priority-weighted, no capacity cap):
--   priorityWeight(job) = exp((daysInLab - slaWorkdays) / aging_exponent)
--   operationalTarget   = sum(priorityWeight) + intakeProjection + rollover
--   slaFloor            = count(jobs with workday SLA deadline ≤ today) + slaFloorRollover
--   target              = max(operationalTarget, slaFloor)
--
-- v1 (current) and v2 run side-by-side via ?formula=v2 query flag for
-- 24h before the dashboard default flips. The schema additions are
-- additive — v1 rows keep their existing values, formula_version=1.
-- v2 rows populate the new fields and set formula_version=2.

-- ── daily_ship_targets: signal columns for the planning module ────────
-- Each represents a snapshot value at the time of the daily target
-- freeze. Planning module queries this time series to spot trends.
ALTER TABLE daily_ship_targets ADD COLUMN aged_wip            INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN fresh_wip           INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN unknown_wip         INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN priority_weighted   REAL    DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN intake_projection   INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN capacity_estimate   INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN rollover_in         INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN operational_target  INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN sla_floor           INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN gap                 INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets ADD COLUMN formula_version     INTEGER DEFAULT 1;

-- ── lab_planning_config: tunable knobs for the planning module ───────
-- All target / capacity / forecast parameters live here so the planning
-- module can run "what-if" scenarios by overriding values without code
-- changes. Future scenario UI just toggles config rows.
CREATE TABLE IF NOT EXISTS lab_planning_config (
  key         TEXT PRIMARY KEY,
  value       REAL NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the defaults agreed 2026-05-08:
INSERT OR IGNORE INTO lab_planning_config (key, value, description) VALUES
  ('aging_exponent',       1.5,    'Steepness of priority weight curve. Smaller = sharper escalation for aged jobs. weight = exp((daysInLab - slaWorkdays) / aging_exponent).'),
  ('intake_window_days',   14.0,   'Rolling window (workdays) for daily-intake projection. 14 = ~3 weeks of work data.'),
  ('capacity_window_days', 14.0,   'Rolling window (workdays) for capacity-estimate avg ship rate. 14 = self-tuning baseline.'),
  ('rollover_layers',      1.0,    'How many prior-workday misses to roll into today. 1 = yesterday only (avoids double-stacking).'),
  ('desired_eow_wip',      1500.0, 'Optional operational queue-size goal for Friday EOD. Used by the planning module for week-level pacing recommendations.'),
  ('formula_version',      2.0,    'Active target-formula version. 1 = legacy (wip × fraction). 2 = priority-weighted (current).');
