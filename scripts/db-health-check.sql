-- ═══════════════════════════════════════════════════════════════════════════
-- Lab_Assistant DB Health Check
-- ═══════════════════════════════════════════════════════════════════════════
-- Purpose: Surface tables that have gone stale, sparse, or have timestamp
--          format drift. Runs read-only against lab_assistant.db.
--
-- Usage:   sqlite3 /Users/Shared/lab_assistant/data/lab_assistant.db \
--              < /Users/Shared/lab_assistant/scripts/db-health-check.sql
--
-- Or via the shell wrapper:
--          /Users/Shared/lab_assistant/scripts/db-health-check.sh
--
-- Design notes:
--   * Class A = live append-only tables (rows added every day). Checked
--     for freshness, coverage, and timestamp format.
--   * Class B = snapshot tables (rows refreshed, not appended). Checked
--     for a "last refresh" heartbeat only.
--   * Class C = reference/config tables. Row count only.
--   * Freshness query uses julianday() diff in hours. SQLite's julianday
--     interprets datetime text as UTC when no timezone is present — so
--     hours_stale is a UTC comparison. That is the correct baseline for
--     flagging "no rows in 24h"; use the coverage histogram to judge
--     per-day shape in PT.
--   * Coverage histogram uses date(ts) which truncates to UTC date.
--     Rows from the tail end of PT days may fall into the next UTC day.
--     Interpret the last 2 days with that in mind — a borderline sparse
--     "today" often comes from only having a few UTC hours of data yet.
--   * Timestamp format check catches mixed Z / +offset / naive forms.
--     The pickSync bug that triggered this script came from a cursor
--     comparison that inverted across PT/UTC boundaries on naive strings.
--
-- Thresholds (tunable — edit below if lab volume shifts):
--   picks_history         < 1000/day = SPARSE
--   transactions          < 500/day  = SPARSE
--   shipped_jobs          < 200/day  = SPARSE
--   dvi_shipped_jobs      < 200/day  = SPARSE
--   dvi_jobs_history      < 200/day  = SPARSE
--   breakage_events       < 5/day    = SPARSE  (low-volume, 0 rows is suspicious)
--   job_events            < 1000/day = SPARSE
--   oven_runs             < 10/day   = SPARSE
--   coating_runs          < 10/day   = SPARSE
--   som_device_history    < 100/day  = SPARSE  (30s polling = ~2800/day theoretical)
--   vision_reads          < 50/day   = SPARSE
--   downtime_records      < 1/day    = SPARSE  (can legitimately be 0)
--   sync_log              < 50/day   = SPARSE  (many sources, multiple runs each)
--   user_activity         < 20/day   = SPARSE
--   dvi_imports           < 1/day    = SPARSE
--
-- Freshness alert threshold: any Class A table with hours_stale > 24 is ALERT.
-- ═══════════════════════════════════════════════════════════════════════════

.headers on
.mode column
.timer off

SELECT '' AS '';
SELECT '╔═══════════════════════════════════════════════════════════════════════╗' AS '';
SELECT '║  Lab_Assistant DB Health Check                                        ║' AS '';
SELECT '║  ' || datetime('now') || ' UTC / ' || datetime('now','localtime') || ' local                       ║' AS '';
SELECT '╚═══════════════════════════════════════════════════════════════════════╝' AS '';
SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — FRESHNESS ROLLUP (all class A tables, single output)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT '=== 1. FRESHNESS ROLLUP (class A — live append-only) ===' AS '';
SELECT '    hours_stale > 24 means this table has not received a new row in over a day' AS '';
SELECT '' AS '';

SELECT table_name, ts_col, total_rows, latest, hours_stale,
       CASE WHEN latest IS NULL THEN 'EMPTY'
            WHEN hours_stale > 72 THEN 'ALERT-CRIT'
            WHEN hours_stale > 24 THEN 'ALERT'
            WHEN hours_stale > 6  THEN 'WARN'
            ELSE 'OK' END AS status
FROM (
  SELECT 'picks_history' AS table_name, 'completed_at' AS ts_col,
         (SELECT COUNT(*) FROM picks_history) AS total_rows,
         (SELECT MAX(completed_at) FROM picks_history) AS latest,
         CAST((julianday('now') - julianday((SELECT MAX(completed_at) FROM picks_history))) * 24 AS INT) AS hours_stale
  UNION ALL SELECT 'transactions','creation_date',
         (SELECT COUNT(*) FROM transactions),
         (SELECT MAX(creation_date) FROM transactions),
         CAST((julianday('now') - julianday((SELECT MAX(creation_date) FROM transactions))) * 24 AS INT)
  UNION ALL SELECT 'shipped_jobs','date',
         (SELECT COUNT(*) FROM shipped_jobs),
         (SELECT MAX(date) FROM shipped_jobs),
         CAST((julianday('now') - julianday((SELECT MAX(date) FROM shipped_jobs))) * 24 AS INT)
  UNION ALL SELECT 'dvi_shipped_jobs','ship_date',
         (SELECT COUNT(*) FROM dvi_shipped_jobs),
         (SELECT MAX(ship_date) FROM dvi_shipped_jobs),
         CAST((julianday('now') - julianday((SELECT MAX(ship_date) FROM dvi_shipped_jobs))) * 24 AS INT)
  UNION ALL SELECT 'dvi_jobs_history','recorded_at',
         (SELECT COUNT(*) FROM dvi_jobs_history),
         (SELECT MAX(recorded_at) FROM dvi_jobs_history),
         CAST((julianday('now') - julianday((SELECT MAX(recorded_at) FROM dvi_jobs_history))) * 24 AS INT)
  UNION ALL SELECT 'breakage_events','occurred_at',
         (SELECT COUNT(*) FROM breakage_events),
         (SELECT MAX(occurred_at) FROM breakage_events),
         CAST((julianday('now') - julianday((SELECT MAX(occurred_at) FROM breakage_events))) * 24 AS INT)
  UNION ALL SELECT 'job_events','event_time',
         (SELECT COUNT(*) FROM job_events),
         (SELECT MAX(event_time) FROM job_events),
         CAST((julianday('now') - julianday((SELECT MAX(event_time) FROM job_events))) * 24 AS INT)
  UNION ALL SELECT 'oven_runs','created_at',
         (SELECT COUNT(*) FROM oven_runs),
         (SELECT MAX(created_at) FROM oven_runs),
         CAST((julianday('now') - julianday((SELECT MAX(created_at) FROM oven_runs))) * 24 AS INT)
  UNION ALL SELECT 'coating_runs','created_at',
         (SELECT COUNT(*) FROM coating_runs),
         (SELECT MAX(created_at) FROM coating_runs),
         CAST((julianday('now') - julianday((SELECT MAX(created_at) FROM coating_runs))) * 24 AS INT)
  UNION ALL SELECT 'som_device_history','recorded_at',
         (SELECT COUNT(*) FROM som_device_history),
         (SELECT MAX(recorded_at) FROM som_device_history),
         CAST((julianday('now') - julianday((SELECT MAX(recorded_at) FROM som_device_history))) * 24 AS INT)
  UNION ALL SELECT 'vision_reads','scanned_at',
         (SELECT COUNT(*) FROM vision_reads),
         (SELECT MAX(scanned_at) FROM vision_reads),
         CAST((julianday('now') - julianday((SELECT MAX(scanned_at) FROM vision_reads))) * 24 AS INT)
  UNION ALL SELECT 'downtime_records','start_time',
         (SELECT COUNT(*) FROM downtime_records),
         (SELECT MAX(start_time) FROM downtime_records),
         CAST((julianday('now') - julianday((SELECT MAX(start_time) FROM downtime_records))) * 24 AS INT)
  UNION ALL SELECT 'purchase_orders_history','recorded_at',
         (SELECT COUNT(*) FROM purchase_orders_history),
         (SELECT MAX(recorded_at) FROM purchase_orders_history),
         CAST((julianday('now') - julianday((SELECT MAX(recorded_at) FROM purchase_orders_history))) * 24 AS INT)
  UNION ALL SELECT 'sync_log','synced_at',
         (SELECT COUNT(*) FROM sync_log),
         (SELECT MAX(synced_at) FROM sync_log),
         CAST((julianday('now') - julianday((SELECT MAX(synced_at) FROM sync_log))) * 24 AS INT)
  UNION ALL SELECT 'user_activity','timestamp',
         (SELECT COUNT(*) FROM user_activity),
         (SELECT MAX(timestamp) FROM user_activity),
         CAST((julianday('now') - julianday((SELECT MAX(timestamp) FROM user_activity))) * 24 AS INT)
  UNION ALL SELECT 'dvi_imports','processed_at',
         (SELECT COUNT(*) FROM dvi_imports),
         (SELECT MAX(processed_at) FROM dvi_imports),
         CAST((julianday('now') - julianday((SELECT MAX(processed_at) FROM dvi_imports))) * 24 AS INT)
  UNION ALL SELECT 'looker_jobs','sent_from_lab_date',
         (SELECT COUNT(*) FROM looker_jobs),
         (SELECT MAX(sent_from_lab_date) FROM looker_jobs),
         CAST((julianday('now') - julianday((SELECT MAX(sent_from_lab_date) FROM looker_jobs))) * 24 AS INT)
) ORDER BY CASE status WHEN 'ALERT-CRIT' THEN 0 WHEN 'ALERT' THEN 1 WHEN 'EMPTY' THEN 2 WHEN 'WARN' THEN 3 ELSE 4 END, table_name;

SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — SNAPSHOT TABLE HEARTBEATS (class B)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT '=== 2. SNAPSHOT HEARTBEATS (class B — refreshed, not appended) ===' AS '';
SELECT '    Should update at least daily; look at last_sync / recorded_at / updated_at' AS '';
SELECT '' AS '';

SELECT table_name, ts_col, total_rows, latest, hours_stale,
       CASE WHEN latest IS NULL THEN 'EMPTY'
            WHEN hours_stale > 48 THEN 'ALERT'
            WHEN hours_stale > 24 THEN 'WARN'
            ELSE 'OK' END AS status
FROM (
  SELECT 'dvi_jobs' AS table_name, 'last_sync' AS ts_col,
         (SELECT COUNT(*) FROM dvi_jobs) AS total_rows,
         (SELECT MAX(last_sync) FROM dvi_jobs) AS latest,
         CAST((julianday('now') - julianday((SELECT MAX(last_sync) FROM dvi_jobs))) * 24 AS INT) AS hours_stale
  UNION ALL SELECT 'dvi_trace_jobs','updated_at',
         (SELECT COUNT(*) FROM dvi_trace_jobs),
         (SELECT MAX(updated_at) FROM dvi_trace_jobs),
         CAST((julianday('now') - julianday((SELECT MAX(updated_at) FROM dvi_trace_jobs))) * 24 AS INT)
  UNION ALL SELECT 'jobs','updated_at',
         (SELECT COUNT(*) FROM jobs),
         (SELECT MAX(updated_at) FROM jobs),
         CAST((julianday('now') - julianday((SELECT MAX(updated_at) FROM jobs))) * 24 AS INT)
  UNION ALL SELECT 'picks','synced_at',
         (SELECT COUNT(*) FROM picks),
         (SELECT MAX(synced_at) FROM picks),
         CAST((julianday('now') - julianday((SELECT MAX(synced_at) FROM picks))) * 24 AS INT)
  UNION ALL SELECT 'inventory','last_sync',
         (SELECT COUNT(*) FROM inventory),
         (SELECT MAX(last_sync) FROM inventory),
         CAST((julianday('now') - julianday((SELECT MAX(last_sync) FROM inventory))) * 24 AS INT)
  UNION ALL SELECT 'purchase_orders','last_sync',
         (SELECT COUNT(*) FROM purchase_orders),
         (SELECT MAX(last_sync) FROM purchase_orders),
         CAST((julianday('now') - julianday((SELECT MAX(last_sync) FROM purchase_orders))) * 24 AS INT)
  UNION ALL SELECT 'coating_queue','last_sync',
         (SELECT COUNT(*) FROM coating_queue),
         (SELECT MAX(last_sync) FROM coating_queue),
         CAST((julianday('now') - julianday((SELECT MAX(last_sync) FROM coating_queue))) * 24 AS INT)
  UNION ALL SELECT 'daily_stats','created_at',
         (SELECT COUNT(*) FROM daily_stats),
         (SELECT MAX(created_at) FROM daily_stats),
         CAST((julianday('now') - julianday((SELECT MAX(created_at) FROM daily_stats))) * 24 AS INT)
  UNION ALL SELECT 'throughput_daily','updated_at',
         (SELECT COUNT(*) FROM throughput_daily),
         (SELECT MAX(updated_at) FROM throughput_daily),
         CAST((julianday('now') - julianday((SELECT MAX(updated_at) FROM throughput_daily))) * 24 AS INT)
  UNION ALL SELECT 'aging_buckets','updated_at',
         (SELECT COUNT(*) FROM aging_buckets),
         (SELECT MAX(updated_at) FROM aging_buckets),
         CAST((julianday('now') - julianday((SELECT MAX(updated_at) FROM aging_buckets))) * 24 AS INT)
  UNION ALL SELECT 'daily_ship_targets','captured_at',
         (SELECT COUNT(*) FROM daily_ship_targets),
         (SELECT MAX(captured_at) FROM daily_ship_targets),
         CAST((julianday('now') - julianday((SELECT MAX(captured_at) FROM daily_ship_targets))) * 24 AS INT)
) ORDER BY CASE status WHEN 'ALERT' THEN 0 WHEN 'EMPTY' THEN 1 WHEN 'WARN' THEN 2 ELSE 3 END, table_name;

SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — COVERAGE HISTOGRAM (last 14 days, one block per class A table)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT '=== 3. COVERAGE HISTOGRAM (last 14 days per table) ===' AS '';
SELECT '    Any day flagged SPARSE or ZERO = silent sync failure candidate' AS '';
SELECT '' AS '';

SELECT '--- picks_history (threshold: <1000/day = SPARSE) ---' AS '';
SELECT date(completed_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 1000 THEN 'SPARSE' ELSE 'OK' END AS status
FROM picks_history
WHERE completed_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- transactions (threshold: <500/day = SPARSE) ---' AS '';
SELECT date(creation_date) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 500 THEN 'SPARSE' ELSE 'OK' END AS status
FROM transactions
WHERE creation_date >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- shipped_jobs (threshold: <200/day = SPARSE) ---' AS '';
SELECT date AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 200 THEN 'SPARSE' ELSE 'OK' END AS status
FROM shipped_jobs
WHERE date >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- dvi_shipped_jobs (threshold: <200/day = SPARSE) ---' AS '';
SELECT ship_date AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 200 THEN 'SPARSE' ELSE 'OK' END AS status
FROM dvi_shipped_jobs
WHERE ship_date >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- dvi_jobs_history (threshold: <200/day = SPARSE) ---' AS '';
SELECT date(recorded_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 200 THEN 'SPARSE' ELSE 'OK' END AS status
FROM dvi_jobs_history
WHERE recorded_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- breakage_events (threshold: 0 rows = ZERO only — low volume table) ---' AS '';
SELECT date(occurred_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO' ELSE 'OK' END AS status
FROM breakage_events
WHERE occurred_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- job_events (threshold: <1000/day = SPARSE) ---' AS '';
SELECT date(event_time) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 1000 THEN 'SPARSE' ELSE 'OK' END AS status
FROM job_events
WHERE event_time >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- oven_runs (threshold: <10/day = SPARSE) ---' AS '';
SELECT date(created_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 10 THEN 'SPARSE' ELSE 'OK' END AS status
FROM oven_runs
WHERE created_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- coating_runs (threshold: <10/day = SPARSE) ---' AS '';
SELECT date(created_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 10 THEN 'SPARSE' ELSE 'OK' END AS status
FROM coating_runs
WHERE created_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- som_device_history (threshold: <100/day = SPARSE; 30s poll = thousands expected) ---' AS '';
SELECT date(recorded_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 100 THEN 'SPARSE' ELSE 'OK' END AS status
FROM som_device_history
WHERE recorded_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- vision_reads (threshold: <50/day = SPARSE) ---' AS '';
SELECT date(scanned_at) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 50 THEN 'SPARSE' ELSE 'OK' END AS status
FROM vision_reads
WHERE scanned_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- sync_log (threshold: <50/day = SPARSE; every adapter writes here) ---' AS '';
SELECT date(synced_at) AS d, COUNT(*) AS n,
  SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 50 THEN 'SPARSE' ELSE 'OK' END AS status
FROM sync_log
WHERE synced_at >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

SELECT '--- user_activity (threshold: <20/day = SPARSE) ---' AS '';
SELECT date(timestamp) AS d, COUNT(*) AS n,
  CASE WHEN COUNT(*) = 0 THEN 'ZERO'
       WHEN COUNT(*) < 20 THEN 'SPARSE' ELSE 'OK' END AS status
FROM user_activity
WHERE timestamp >= date('now','-14 days')
GROUP BY d ORDER BY d DESC;
SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4 — TIMESTAMP FORMAT DRIFT (class A tables)
-- ═══════════════════════════════════════════════════════════════════════════
-- The pickSync incident was caused by naive strings compared against an
-- offset-bearing cursor. Mixed formats in the same column are the root
-- cause signal — pick a form and enforce it in the writer. Expect ONE
-- non-zero column per row below; two or more means drift.
SELECT '=== 4. TIMESTAMP FORMAT DRIFT (class A) ===' AS '';
SELECT '    Expect exactly ONE non-zero column per row. Mixed = drift = cursor-bug risk.' AS '';
SELECT '' AS '';

SELECT col, z_suffix, offset_form, naive_form, null_count,
       CASE WHEN (CASE WHEN z_suffix>0 THEN 1 ELSE 0 END
                + CASE WHEN offset_form>0 THEN 1 ELSE 0 END
                + CASE WHEN naive_form>0 THEN 1 ELSE 0 END) > 1
            THEN 'MIXED' ELSE 'OK' END AS status
FROM (
  SELECT 'picks_history.completed_at' AS col,
    SUM(CASE WHEN completed_at LIKE '%Z' THEN 1 ELSE 0 END) AS z_suffix,
    SUM(CASE WHEN completed_at LIKE '%+%:%' OR (completed_at LIKE '%-__:__' AND completed_at NOT LIKE '____-__-__') THEN 1 ELSE 0 END) AS offset_form,
    SUM(CASE WHEN completed_at IS NOT NULL AND completed_at NOT LIKE '%Z'
              AND NOT (completed_at LIKE '%+%:%' OR (completed_at LIKE '%-__:__' AND completed_at NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END) AS naive_form,
    SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS null_count
  FROM picks_history
  UNION ALL
  SELECT 'transactions.creation_date',
    SUM(CASE WHEN creation_date LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN creation_date LIKE '%+%:%' OR (creation_date LIKE '%-__:__' AND creation_date NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN creation_date IS NOT NULL AND creation_date NOT LIKE '%Z'
              AND NOT (creation_date LIKE '%+%:%' OR (creation_date LIKE '%-__:__' AND creation_date NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN creation_date IS NULL THEN 1 ELSE 0 END)
  FROM transactions
  UNION ALL
  SELECT 'dvi_shipped_jobs.ship_date',
    SUM(CASE WHEN ship_date LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN ship_date LIKE '%+%:%' OR (ship_date LIKE '%-__:__' AND ship_date NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN ship_date IS NOT NULL AND ship_date NOT LIKE '%Z'
              AND NOT (ship_date LIKE '%+%:%' OR (ship_date LIKE '%-__:__' AND ship_date NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN ship_date IS NULL THEN 1 ELSE 0 END)
  FROM dvi_shipped_jobs
  UNION ALL
  SELECT 'dvi_jobs_history.recorded_at',
    SUM(CASE WHEN recorded_at LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_at LIKE '%+%:%' OR (recorded_at LIKE '%-__:__' AND recorded_at NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_at IS NOT NULL AND recorded_at NOT LIKE '%Z'
              AND NOT (recorded_at LIKE '%+%:%' OR (recorded_at LIKE '%-__:__' AND recorded_at NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_at IS NULL THEN 1 ELSE 0 END)
  FROM dvi_jobs_history
  UNION ALL
  SELECT 'breakage_events.occurred_at',
    SUM(CASE WHEN occurred_at LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN occurred_at LIKE '%+%:%' OR (occurred_at LIKE '%-__:__' AND occurred_at NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN occurred_at IS NOT NULL AND occurred_at NOT LIKE '%Z'
              AND NOT (occurred_at LIKE '%+%:%' OR (occurred_at LIKE '%-__:__' AND occurred_at NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END)
  FROM breakage_events
  UNION ALL
  SELECT 'job_events.event_time',
    SUM(CASE WHEN event_time LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN event_time LIKE '%+%:%' OR (event_time LIKE '%-__:__' AND event_time NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN event_time IS NOT NULL AND event_time NOT LIKE '%Z'
              AND NOT (event_time LIKE '%+%:%' OR (event_time LIKE '%-__:__' AND event_time NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN event_time IS NULL THEN 1 ELSE 0 END)
  FROM job_events
  UNION ALL
  SELECT 'som_device_history.recorded_at',
    SUM(CASE WHEN recorded_at LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_at LIKE '%+%:%' OR (recorded_at LIKE '%-__:__' AND recorded_at NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_at IS NOT NULL AND recorded_at NOT LIKE '%Z'
              AND NOT (recorded_at LIKE '%+%:%' OR (recorded_at LIKE '%-__:__' AND recorded_at NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_at IS NULL THEN 1 ELSE 0 END)
  FROM som_device_history
  UNION ALL
  SELECT 'vision_reads.scanned_at',
    SUM(CASE WHEN scanned_at LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN scanned_at LIKE '%+%:%' OR (scanned_at LIKE '%-__:__' AND scanned_at NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN scanned_at IS NOT NULL AND scanned_at NOT LIKE '%Z'
              AND NOT (scanned_at LIKE '%+%:%' OR (scanned_at LIKE '%-__:__' AND scanned_at NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN scanned_at IS NULL THEN 1 ELSE 0 END)
  FROM vision_reads
  UNION ALL
  SELECT 'sync_log.synced_at',
    SUM(CASE WHEN synced_at LIKE '%Z' THEN 1 ELSE 0 END),
    SUM(CASE WHEN synced_at LIKE '%+%:%' OR (synced_at LIKE '%-__:__' AND synced_at NOT LIKE '____-__-__') THEN 1 ELSE 0 END),
    SUM(CASE WHEN synced_at IS NOT NULL AND synced_at NOT LIKE '%Z'
              AND NOT (synced_at LIKE '%+%:%' OR (synced_at LIKE '%-__:__' AND synced_at NOT LIKE '____-__-__'))
             THEN 1 ELSE 0 END),
    SUM(CASE WHEN synced_at IS NULL THEN 1 ELSE 0 END)
  FROM sync_log
);

SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5 — RECENT SYNC_LOG ERRORS (last 48h)
-- ═══════════════════════════════════════════════════════════════════════════
-- A sync that reports "ok" with 0 rows is the silent failure we're chasing.
-- Surface both: actual errors AND suspicious ok-with-0-rows runs.
SELECT '=== 5. RECENT SYNC ERRORS / ZERO-ROW SUCCESSES (last 48h) ===' AS '';
SELECT '    Zero-row OKs are the pickSync-style silent-failure signature' AS '';
SELECT '' AS '';

SELECT source, synced_at, record_count, status, substr(COALESCE(error,''),1,80) AS error_snippet
FROM sync_log
WHERE synced_at >= datetime('now','-2 days')
  AND (status != 'ok' OR (status = 'ok' AND COALESCE(record_count,0) = 0))
ORDER BY synced_at DESC
LIMIT 50;

SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6 — SYNC FREQUENCY PER SOURCE (last 24h)
-- ═══════════════════════════════════════════════════════════════════════════
-- If a source has stopped running entirely, it won't appear as "error" —
-- it just goes missing from sync_log. Compare counts to your expected cadence.
SELECT '=== 6. SYNC FREQUENCY BY SOURCE (last 24h) ===' AS '';
SELECT '    A source that used to run and is now absent here is a silent stop' AS '';
SELECT '' AS '';

SELECT source,
       COUNT(*) AS runs_24h,
       SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_runs,
       SUM(CASE WHEN status='ok' AND COALESCE(record_count,0)=0 THEN 1 ELSE 0 END) AS ok_zero_rows,
       SUM(COALESCE(record_count,0)) AS total_rows,
       MAX(synced_at) AS last_run
FROM sync_log
WHERE synced_at >= datetime('now','-1 day')
GROUP BY source
ORDER BY last_run DESC;

SELECT '' AS '';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7 — REFERENCE TABLE ROW COUNTS (class C — should be non-zero)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT '=== 7. REFERENCE / CONFIG TABLES (class C — should be stable, non-empty) ===' AS '';
SELECT '' AS '';

SELECT table_name, row_count,
       CASE WHEN row_count = 0 THEN 'EMPTY' ELSE 'OK' END AS status
FROM (
  SELECT 'lens_sku_params' AS table_name, (SELECT COUNT(*) FROM lens_sku_params) AS row_count
  UNION ALL SELECT 'lens_catalog',    (SELECT COUNT(*) FROM lens_catalog)
  UNION ALL SELECT 'frame_catalog',   (SELECT COUNT(*) FROM frame_catalog)
  UNION ALL SELECT 'operators',       (SELECT COUNT(*) FROM operators)
  UNION ALL SELECT 'users',           (SELECT COUNT(*) FROM users)
  UNION ALL SELECT 'assembly_config', (SELECT COUNT(*) FROM assembly_config)
  UNION ALL SELECT 'maintenance_assets', (SELECT COUNT(*) FROM maintenance_assets)
  UNION ALL SELECT 'npi_scenarios',   (SELECT COUNT(*) FROM npi_scenarios)
) ORDER BY status DESC, table_name;

SELECT '' AS '';
SELECT '=== END OF HEALTH CHECK ===' AS '';
SELECT '' AS '';
