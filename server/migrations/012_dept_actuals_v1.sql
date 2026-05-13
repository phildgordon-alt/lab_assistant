-- 012_dept_actuals_v1.sql
--
-- Goal-vs-actual history infrastructure for departments that don't
-- have their own daily-target table.
--
-- Shipping already has daily_ship_targets (migration 009 — target +
-- shipped_actual + variance per day).
-- Coating already has daily_coating_targets (migration 011 — target +
-- coated_actual + variance per day).
--
-- Cutting and Assembly don't have their own target tables. Per Phil's
-- 2026-05-11 decision: cutting target = ship target (everything that
-- ships passes through cutting), and assembly target = ship target
-- (assembled count drives shipped count). So we don't need separate
-- target tables — just an actuals row per (date, dept) joined against
-- daily_ship_targets.total_target at query time.
--
-- The history endpoints (one per department) JOIN this table with the
-- appropriate target source:
--   shipping → daily_ship_targets       (target + actual same table)
--   coating  → daily_coating_targets    (target + actual same table)
--   cutting  → daily_ship_targets.total_target  +  daily_dept_actuals.actual WHERE dept='cutting'
--   assembly → daily_ship_targets.total_target  +  daily_dept_actuals.actual WHERE dept='assembly'
--
-- This keeps a single source of truth on the target value (we don't
-- duplicate total_target across 3 tables and risk drift after a
-- backfill).

CREATE TABLE IF NOT EXISTS daily_dept_actuals (
  date         TEXT NOT NULL,        -- YYYY-MM-DD (PT-local)
  dept         TEXT NOT NULL,        -- 'assembly' | 'cutting'
  actual       INTEGER DEFAULT 0,    -- count produced that day
  captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT,                 -- set at 11 PM PT, snapshot frozen
  PRIMARY KEY (date, dept)
);

CREATE INDEX IF NOT EXISTS idx_dda_date ON daily_dept_actuals(date);
CREATE INDEX IF NOT EXISTS idx_dda_dept ON daily_dept_actuals(dept);
