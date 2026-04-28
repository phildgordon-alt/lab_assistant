-- health-check.sql — Lab_Assistant data validity gate
-- Run any time:  sqlite3 -header -column data/lab_assistant.db < scripts/health-check.sql
-- Healthy state: every row's "n" column = 0 (or matching documented residual).
-- 5 AM cron should alert Slack if any row is non-zero.

SELECT 'guid_orphans (picks_history)' AS metric,
       (SELECT COUNT(*) FROM picks_history
          WHERE LENGTH(order_id) >= 32 AND order_id LIKE '%-%') AS n,
       'picks_history rows with GUID-shaped order_id (cannot join jobs.invoice)' AS expect_zero
UNION ALL
SELECT 'picks_orphans (unjoinable)',
       (SELECT COUNT(*) FROM picks_history ph
          LEFT JOIN jobs j ON j.invoice = ph.order_id
          WHERE j.invoice IS NULL),
       'picks_history rows whose order_id has no matching jobs.invoice'
UNION ALL
SELECT 'past_pick_violations',
       (SELECT COUNT(DISTINCT j.invoice) FROM jobs j
          JOIN picks_history ph ON ph.order_id = j.invoice
          WHERE j.status NOT IN ('SHIPPED','CANCELLED','CANCELED')
            AND (j.lens_type IS NULL OR j.lens_type = '')),
       'active jobs WITH a pick row but no lens_type (impossible per Phil)'
UNION ALL
SELECT 'corrupt_invoices',
       (SELECT COUNT(*) FROM jobs
          WHERE invoice NOT GLOB '[0-9][0-9][0-9][0-9]*' OR invoice IS NULL),
       'jobs.invoice not 4+ digit numeric (parser garbage)'
UNION ALL
SELECT 'shipped_xref_not_propagated',
       (SELECT COUNT(*) FROM dvi_shipped_jobs dsj
          JOIN jobs j ON j.invoice = dsj.invoice
          WHERE j.status != 'SHIPPED'),
       'dvi_shipped_jobs row exists but jobs.status != SHIPPED (back-prop gap)'
UNION ALL
SELECT 'stale_shipping_no_xref',
       (SELECT COUNT(*) FROM jobs j
          WHERE j.current_stage = 'SHIPPING'
            AND j.status != 'SHIPPED'
            AND (j.last_event_at IS NULL OR j.last_event_at < datetime('now','-7 days'))
            AND NOT EXISTS (SELECT 1 FROM dvi_shipped_jobs dsj WHERE dsj.invoice = j.invoice)),
       'SHIPPING-stuck >7d with no SHIPLOG xref (run reconcile-shipped-jobs)'
UNION ALL
SELECT 'active_wip_null_lens_type',
       (SELECT COUNT(*) FROM jobs
          WHERE status NOT IN ('SHIPPED','CANCELLED','CANCELED')
            AND (lens_type IS NULL OR lens_type = '')),
       'active jobs with NULL lens_type (residual after backfill — track downward)'
UNION ALL
SELECT 'pct_recent_shipped_with_material',
       (SELECT CAST(ROUND(100.0 *
              SUM(CASE WHEN lens_material IS NOT NULL AND lens_material != '' THEN 1.0 ELSE 0 END)
              / NULLIF(COUNT(*),0), 1) AS INTEGER)
        FROM jobs WHERE ship_date >= date('now','-1 day')),
       'percent of recently-shipped jobs with lens_material (target: > 80)'
UNION ALL
SELECT 'shipped_no_xref_count',
       (SELECT COUNT(*) FROM jobs WHERE shipped_no_xref = 1),
       'jobs flipped to SHIPPED via stale-flag (informational, growing slowly is OK)';
