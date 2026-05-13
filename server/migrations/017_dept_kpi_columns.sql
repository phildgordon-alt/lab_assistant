-- 017_dept_kpi_columns.sql
--
-- Phil 2026-05-13 late: add living KPI tiles to every dept landing page.
-- Each dept tab shows 4 universal KPIs + 1-2 dept-specific. KPIs persist
-- daily so the GoalHistory click-through can show a full daily snapshot.
--
-- KPI columns added to all 4 existing target tables. Assembly and Cutting
-- share the ship target (no dedicated target table) so they get their own
-- daily_*_kpis tables instead — preserves the parallel shape across all 6
-- depts even though the target source-of-truth differs.
--
-- 4 Universal KPIs (every dept):
--   kpi_aging_count        Count of WIP in this dept with dwell-in-dept >
--                          threshold (default 24h). Phil 2026-05-13:
--                          "if it stays in the department for more than a
--                          day, that's something we need to know."
--   kpi_max_age_hours      Max dwell-in-dept of any WIP in this dept.
--                          Drives tile color (green <2d, amber 2-5d,
--                          red >=5d). Surfaces the 10-day outlier.
--   kpi_avg_dwell_hours    Mean dwell-in-dept of current WIP.
--                          Trend signal vs aging count's action signal.
--   kpi_breakage_pct       count(breakage_events today, dept=X) /
--                          count(jobs exited stage today). Goal: <2% (98%
--                          pass rate). Threshold seeds below.
--   kpi_breakage_count     Raw count of breakage_events today, dept=X.
--                          Stored alongside the % so the detail panel can
--                          show both without a re-query.
--   kpi_throughput_per_hour
--                          Distinct invoices that exited this stage in
--                          the last 60 min (rolling).
--
-- Dept-specific KPIs (1-2 per dept):
--   kpi_dept_specific      JSON blob holding the dept's specific KPI
--                          values. Schema-on-read; each dept's reader
--                          knows its keys. Keeps the table flat across
--                          all 6 depts without exploding the column count.
--
-- All KPI columns default to 0 / '{}' so existing rows remain valid.
-- captureDailyDeptKpis fills them hourly; backfill script extends to fill
-- historical rows.

-- ============================================================
-- 1) Extend existing target tables with KPI snapshot columns
-- ============================================================

ALTER TABLE daily_ship_targets       ADD COLUMN kpi_aging_count        INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets       ADD COLUMN kpi_max_age_hours      REAL    DEFAULT 0;
ALTER TABLE daily_ship_targets       ADD COLUMN kpi_avg_dwell_hours    REAL    DEFAULT 0;
ALTER TABLE daily_ship_targets       ADD COLUMN kpi_breakage_pct       REAL    DEFAULT 0;
ALTER TABLE daily_ship_targets       ADD COLUMN kpi_breakage_count     INTEGER DEFAULT 0;
ALTER TABLE daily_ship_targets       ADD COLUMN kpi_throughput_per_hour REAL   DEFAULT 0;
ALTER TABLE daily_ship_targets       ADD COLUMN kpi_dept_specific      TEXT    DEFAULT '{}';

ALTER TABLE daily_coating_targets    ADD COLUMN kpi_aging_count        INTEGER DEFAULT 0;
ALTER TABLE daily_coating_targets    ADD COLUMN kpi_max_age_hours      REAL    DEFAULT 0;
ALTER TABLE daily_coating_targets    ADD COLUMN kpi_avg_dwell_hours    REAL    DEFAULT 0;
ALTER TABLE daily_coating_targets    ADD COLUMN kpi_breakage_pct       REAL    DEFAULT 0;
ALTER TABLE daily_coating_targets    ADD COLUMN kpi_breakage_count     INTEGER DEFAULT 0;
ALTER TABLE daily_coating_targets    ADD COLUMN kpi_throughput_per_hour REAL   DEFAULT 0;
ALTER TABLE daily_coating_targets    ADD COLUMN kpi_dept_specific      TEXT    DEFAULT '{}';

ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_aging_count        INTEGER DEFAULT 0;
ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_max_age_hours      REAL    DEFAULT 0;
ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_avg_dwell_hours    REAL    DEFAULT 0;
ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_breakage_pct       REAL    DEFAULT 0;
ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_breakage_count     INTEGER DEFAULT 0;
ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_throughput_per_hour REAL   DEFAULT 0;
ALTER TABLE daily_surfacing_targets  ADD COLUMN kpi_dept_specific      TEXT    DEFAULT '{}';

ALTER TABLE daily_picking_targets    ADD COLUMN kpi_aging_count        INTEGER DEFAULT 0;
ALTER TABLE daily_picking_targets    ADD COLUMN kpi_max_age_hours      REAL    DEFAULT 0;
ALTER TABLE daily_picking_targets    ADD COLUMN kpi_avg_dwell_hours    REAL    DEFAULT 0;
ALTER TABLE daily_picking_targets    ADD COLUMN kpi_breakage_pct       REAL    DEFAULT 0;
ALTER TABLE daily_picking_targets    ADD COLUMN kpi_breakage_count     INTEGER DEFAULT 0;
ALTER TABLE daily_picking_targets    ADD COLUMN kpi_throughput_per_hour REAL   DEFAULT 0;
ALTER TABLE daily_picking_targets    ADD COLUMN kpi_dept_specific      TEXT    DEFAULT '{}';

-- ============================================================
-- 2) New tables for Assembly + Cutting (they share ship target,
-- so no target table to extend — KPIs land in their own home)
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_assembly_kpis (
  date                    TEXT PRIMARY KEY,
  kpi_aging_count         INTEGER DEFAULT 0,
  kpi_max_age_hours       REAL    DEFAULT 0,
  kpi_avg_dwell_hours     REAL    DEFAULT 0,
  kpi_breakage_pct        REAL    DEFAULT 0,
  kpi_breakage_count      INTEGER DEFAULT 0,
  kpi_throughput_per_hour REAL    DEFAULT 0,
  kpi_dept_specific       TEXT    DEFAULT '{}',
  captured_at             TEXT    DEFAULT (datetime('now')),
  backfilled              INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_cutting_kpis (
  date                    TEXT PRIMARY KEY,
  kpi_aging_count         INTEGER DEFAULT 0,
  kpi_max_age_hours       REAL    DEFAULT 0,
  kpi_avg_dwell_hours     REAL    DEFAULT 0,
  kpi_breakage_pct        REAL    DEFAULT 0,
  kpi_breakage_count      INTEGER DEFAULT 0,
  kpi_throughput_per_hour REAL    DEFAULT 0,
  kpi_dept_specific       TEXT    DEFAULT '{}',
  captured_at             TEXT    DEFAULT (datetime('now')),
  backfilled              INTEGER DEFAULT 0
);

-- ============================================================
-- 3) Threshold seeds in lab_planning_config
-- Phil-confirmed defaults; tunable without code edits.
-- ============================================================

INSERT OR IGNORE INTO lab_planning_config (key, value, description) VALUES
  ('kpi_aging_threshold_hours',   24.0,  'Dwell-in-dept threshold (hours) for "aging in dept" count. Phil 2026-05-13: jobs over 1 day in a dept are flagged.'),
  ('kpi_max_age_amber_hours',     48.0,  'Max-dwell amber threshold. Tiles go amber when any single WIP job in dept has been there longer than this.'),
  ('kpi_max_age_red_hours',      120.0,  'Max-dwell red threshold. 5 days in one dept = critical.'),
  ('kpi_breakage_pct_amber',       2.0,  'Breakage % amber threshold. Phil 2026-05-13: 98% pass is the goal, so 2% breakage = warning.'),
  ('kpi_breakage_pct_red',         5.0,  'Breakage % red threshold.'),
  ('kpi_avg_dwell_amber_hours',   18.0,  'Average dwell-in-dept amber. Population trend signal.'),
  ('kpi_avg_dwell_red_hours',     36.0,  'Average dwell-in-dept red.'),
  ('kpi_throughput_window_minutes', 60.0,'Rolling window (minutes) for throughput-rate calc. 60 = jobs/hr.');
