-- 006_dod_zombie_log.sql
--
-- Definition of Done for Task #19: 7 consecutive days where the
-- zombie-row count (jobs.current_stage='SHIPPED' AND ship_date IS NULL)
-- stays at zero. The lab server logs this once per day and bumps a
-- streak counter. After 7 consecutive zero days, Task #19 is verified.
--
-- Schema is deliberately tiny: one row per calendar date, with the
-- count taken at check time. INSERT OR REPLACE so re-running the
-- check on the same day overwrites with the latest value.

CREATE TABLE IF NOT EXISTS dod_zombie_log (
  check_date    TEXT PRIMARY KEY,            -- 'YYYY-MM-DD' lab-local
  zombie_count  INTEGER NOT NULL,
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
