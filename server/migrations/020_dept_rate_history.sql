-- Phil 2026-05-15 — persist rate-per-hour and rate-vs-goal historically.
--
-- Drives empirical analysis: velocity over time, goal-attainment trends,
-- correlation between rate and downtime/incidents. Populated by daily-
-- capture writers (hourly cron in oven-timer-server.js).
--
-- rate_per_hour: shift-elapsed rate at capture time = actual / shift_hours_elapsed
-- rate_vs_goal_pct: (actual / target) × 100, capped at 999

ALTER TABLE daily_ship_targets       ADD COLUMN rate_per_hour    REAL;
ALTER TABLE daily_ship_targets       ADD COLUMN rate_vs_goal_pct REAL;

ALTER TABLE daily_coating_targets    ADD COLUMN rate_per_hour    REAL;
ALTER TABLE daily_coating_targets    ADD COLUMN rate_vs_goal_pct REAL;

ALTER TABLE daily_surfacing_targets  ADD COLUMN rate_per_hour    REAL;
ALTER TABLE daily_surfacing_targets  ADD COLUMN rate_vs_goal_pct REAL;

ALTER TABLE daily_picking_targets    ADD COLUMN rate_per_hour    REAL;
ALTER TABLE daily_picking_targets    ADD COLUMN rate_vs_goal_pct REAL;

-- daily_dept_actuals (cutting/assembly — no target table) gets both columns
-- plus a goal column so cutting/assembly history mirrors the others.
ALTER TABLE daily_dept_actuals       ADD COLUMN target           INTEGER;
ALTER TABLE daily_dept_actuals       ADD COLUMN rate_per_hour    REAL;
ALTER TABLE daily_dept_actuals       ADD COLUMN rate_vs_goal_pct REAL;
