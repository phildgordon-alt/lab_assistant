-- check-timestamp-formats.sql
-- Detect MIXED timestamp string formats in columns used by date(col) / substr(col,1,10) /
-- datetime-range queries in server/*.js. A mixed column is the root cause of the
-- pickSync cursor-inversion class of bug: SQLite date() evaluates in UTC, so when PT
-- times after 4–5 PM PT cross the UTC day boundary, date(col) returns tomorrow's
-- calendar day. If the column is uniformly one format, day-bucketing is still WRONG
-- for PT (7-hour shift) but at least internally consistent.
--
-- Classifications (mutually non-exclusive — a mixed column shows >0 in multiple buckets):
--   z_suffix   — "...Z"           (UTC explicit)
--   offset     — "...+07:00" / "...-07:00"
--   naive      — "YYYY-MM-DD HH:MM:SS[.fff]"  (no tz, space separator)
--   naive_t    — "YYYY-MM-DDTHH:MM:SS[.fff]"  (no tz, T separator)
--   date_only  — "YYYY-MM-DD"
--   other      — anything that matched none of the above (inspect manually)
--
-- Usage:
--   sqlite3 "file:/Users/Shared/lab_assistant/data/lab_assistant.db?mode=ro" \
--     < scripts/check-timestamp-formats.sql
--
-- Run read-only via file: URI (not -readonly, per our established pattern).

.headers on
.mode column

-- ─────────────────────────────────────────────────────────────────────────────
-- picks_history.completed_at  (KNOWN offset-form — source: ItemPath modifiedDate)
--   Referenced: server/itempath-adapter.js:1060, 1063, 1230
--                server/db.js:1814, 1817, 1818, 1825, 1845, 1846, 1849,
--                              1904, 1906, 1907, 1985, 1817–2147...
--                server/oven-timer-server.js:1933, 1936, 1937, 1975, 1977, 1978,
--                              2137, 2147, 3253, 3255, 3256, 6276, 6431, 6433, 6434
--                server/flow-agent.js:2146, 2234, 2411
--                server/binning-intelligence.js:124–125
--                server/lens-intelligence.js:168, 170, 171
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'picks_history.completed_at' AS col,
  COUNT(*)                                                                AS total,
  SUM(CASE WHEN completed_at LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN completed_at GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN completed_at GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN completed_at GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN completed_at GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  MIN(completed_at)                                                       AS sample_min,
  MAX(completed_at)                                                       AS sample_max
FROM picks_history;

-- ─────────────────────────────────────────────────────────────────────────────
-- picks.started_at  (naive ISO with T separator — datetime('now') writes space;
--                    but upsert in server/db.js:1310 uses ItemPath modifiedDate?
--                    Live sample shows 'YYYY-MM-DDTHH:MM:SS.ffffff' form.)
--   Referenced: server/db.js:1705
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'picks.started_at' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN started_at LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN started_at GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN started_at GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN started_at GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN started_at GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  MIN(started_at)                                                       AS sample_min,
  MAX(started_at)                                                       AS sample_max
FROM picks
WHERE started_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- dvi_jobs_history.shipped_at  (naive UTC — written by datetime('now') in db.js:1580)
--   Referenced: server/db.js:1788, 1789, 1795, 1799, 1800, 1806, 1817,
--                              2070
--                server/oven-timer-server.js (no hits — lives behind queryShippedStats)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'dvi_jobs_history.shipped_at' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN shipped_at LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN shipped_at GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN shipped_at GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN shipped_at GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN shipped_at GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  MIN(shipped_at)                                                       AS sample_min,
  MAX(shipped_at)                                                       AS sample_max
FROM dvi_jobs_history
WHERE shipped_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- dvi_shipped_jobs.ship_date  (expected YYYY-MM-DD — source: DVI)
--   Referenced: server/db.js:2822, 2832, 2923, 2925, 2935–2938, 2965
--                server/oven-timer-server.js:2209, 2381, 4372
--                server/flow-agent.js:2242, 2416, 2420
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'dvi_shipped_jobs.ship_date' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN ship_date LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN ship_date GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN ship_date GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN ship_date GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN ship_date GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  MIN(ship_date)                                                       AS sample_min,
  MAX(ship_date)                                                       AS sample_max
FROM dvi_shipped_jobs
WHERE ship_date IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- jobs.ship_date  (same DVI source as dvi_shipped_jobs — expected YYYY-MM-DD)
--   Referenced: server/db.js:2822, 2832, 2925, 2937, 2938, 2965
--                server/oven-timer-server.js:2209, 2381, 4372
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'jobs.ship_date' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN ship_date LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN ship_date GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN ship_date GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN ship_date GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN ship_date GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  MIN(ship_date)                                                       AS sample_min,
  MAX(ship_date)                                                       AS sample_max
FROM jobs
WHERE ship_date IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- dvi_imports.import_date  (date('now') — expected YYYY-MM-DD)
--   Referenced: server/db.js:2040
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'dvi_imports.import_date' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN import_date LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN import_date GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN import_date GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN import_date GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN import_date GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  MIN(import_date)                                                       AS sample_min,
  MAX(import_date)                                                       AS sample_max
FROM dvi_imports;

-- ─────────────────────────────────────────────────────────────────────────────
-- daily_stats.stat_date  (date('now') in updateDailyPickStats)
--   Referenced: server/db.js:1927, 2266
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'daily_stats.stat_date' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN stat_date GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  SUM(CASE WHEN stat_date GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN stat_date GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  SUM(CASE WHEN stat_date LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  MIN(stat_date)                                                       AS sample_min,
  MAX(stat_date)                                                       AS sample_max
FROM daily_stats;

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_snapshots.snapshot_date
--   Referenced: server/db.js:1935
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'inventory_snapshots.snapshot_date' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN snapshot_date GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  SUM(CASE WHEN snapshot_date GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN snapshot_date LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  MIN(snapshot_date)                                                       AS sample_min,
  MAX(snapshot_date)                                                       AS sample_max
FROM inventory_snapshots;

-- ─────────────────────────────────────────────────────────────────────────────
-- aging_buckets.snapshot_date
--   Referenced: server/db.js:2236
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'aging_buckets.snapshot_date' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN snapshot_date GLOB '____-__-__'             THEN 1 ELSE 0 END) AS date_only,
  SUM(CASE WHEN snapshot_date GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  MIN(snapshot_date)                                                       AS sample_min,
  MAX(snapshot_date)                                                       AS sample_max
FROM aging_buckets;

-- ─────────────────────────────────────────────────────────────────────────────
-- ews_readings.ts  (datetime('now') — naive UTC)
--   Referenced: server/lab-config.js:576, 195
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'ews_readings.ts' AS col,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN ts LIKE '%Z'                     THEN 1 ELSE 0 END) AS z_suffix,
  SUM(CASE WHEN ts GLOB '*[+-][0-2][0-9]:[0-5][0-9]' THEN 1 ELSE 0 END) AS offset_form,
  SUM(CASE WHEN ts GLOB '____-__-__ __:__:__*'   THEN 1 ELSE 0 END) AS naive_space,
  SUM(CASE WHEN ts GLOB '____-__-__T__:__:__*'   THEN 1 ELSE 0 END) AS naive_t,
  MIN(ts)                                                       AS sample_min,
  MAX(ts)                                                       AS sample_max
FROM ews_readings;
