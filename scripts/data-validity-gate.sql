-- ═══════════════════════════════════════════════════════════════════════════
-- Lab_Assistant data-validity gate
-- Per-stage required-fields invariants. Healthy = every section returns 0 rows
-- (or matches the documented residual). Run any time:
--
--   sqlite3 /Users/Shared/lab_assistant/data/lab_assistant.db < scripts/data-validity-gate.sql
--
-- Companion to scripts/health-check.sql (single-line metrics). This file
-- enumerates the SPECIFIC ROWS that violate each invariant so you can act.
-- ═══════════════════════════════════════════════════════════════════════════

.headers on
.mode column

-- 1. INVOICE INTEGRITY — primary key must be all-digit, ≥4 chars
SELECT '1. invoice corruption' AS check_, invoice
FROM jobs
WHERE invoice NOT GLOB '[0-9][0-9][0-9][0-9]*' OR invoice GLOB '*[^0-9]*'
LIMIT 25;

-- 2. INCOMING — every job entered in last 7d must have classification + frame
SELECT '2. incoming missing classification' AS check_,
       invoice, reference, lens_type, lens_opc_r, lens_opc_l, frame_upc
FROM jobs
WHERE entry_date >= date('now','-7 days')
  AND (reference IS NULL OR lens_type IS NULL OR lens_opc_r IS NULL OR lens_opc_l IS NULL OR frame_upc IS NULL)
LIMIT 25;

-- 3. ACTIVE WIP past picking — must have picks (R + L lens at minimum)
SELECT '3. active WIP missing picks' AS check_,
       j.invoice, j.reference, j.current_stage,
       (SELECT COUNT(*) FROM picks_history ph WHERE ph.order_id=j.invoice) AS picks
FROM jobs j
WHERE j.status='ACTIVE'
  AND j.current_stage IN ('SURFACING','COATING','CUTTING','ASSEMBLY','QC')
  AND j.first_seen_at >= datetime('now','-30 days')
  AND (SELECT COUNT(*) FROM picks_history ph WHERE ph.order_id=j.invoice) < 2
LIMIT 50;

-- 4. ACTIVE WIP — current_stage and current_station must be populated; last_event recent
SELECT '4. active WIP stale or unstaged' AS check_,
       invoice, current_stage, current_station, last_event_at
FROM jobs
WHERE status='ACTIVE'
  AND (current_stage IS NULL OR current_station IS NULL
       OR julianday('now') - julianday(last_event_at) > 2)
LIMIT 50;

-- 5. SHIPPED back-propagation — dvi_shipped_jobs must reflect in jobs
SELECT '5. shipped back-prop missing' AS check_,
       dsj.invoice, dsj.reference, dsj.ship_date,
       j.status, j.ship_date AS jobs_ship_date
FROM dvi_shipped_jobs dsj
LEFT JOIN jobs j ON j.invoice=dsj.invoice
WHERE dsj.ship_date >= date('now','-30 days')
  AND (j.status IS NULL OR j.status != 'SHIPPED' OR j.ship_date IS NULL)
LIMIT 50;

-- 6. STALE ACTIVE — looker says shipped, jobs row still ACTIVE
SELECT '6. looker says shipped but jobs ACTIVE' AS check_,
       j.invoice, j.reference, lj.sent_from_lab_date
FROM jobs j
JOIN looker_jobs lj ON lj.order_number=j.reference
WHERE lj.sent_from_lab_date IS NOT NULL
  AND lj.sent_from_lab_date >= date('now','-30 days')
  AND j.status='ACTIVE'
LIMIT 50;

-- 7. PICKS HISTORY orphans — pick rows that don't join to any jobs row
SELECT '7. picks_history orphan rows (last 7d)' AS check_, COUNT(*) AS n
FROM picks_history ph
WHERE ph.completed_at >= date('now','-7 days')
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.invoice = ph.order_id);

-- 8. PICKS HISTORY 36-char (GUID) order_id contamination — bug from prior recovery script
SELECT '8. picks_history bad-key (GUID written as order_id)' AS check_, COUNT(*) AS n
FROM picks_history
WHERE length(order_id) = 36;

-- 9. CLASSIFICATION DRIFT — jobs with picks but no lens_type
SELECT '9. lens_type NULL but picks exist (post-PICKING)' AS check_,
       j.invoice, j.current_stage, COUNT(ph.id) AS picks
FROM jobs j
JOIN picks_history ph ON ph.order_id=j.invoice
WHERE j.lens_type IS NULL
  AND j.current_stage NOT IN ('INCOMING','PICKING')
  AND j.status='ACTIVE'
GROUP BY j.invoice
LIMIT 50;

-- 10. SHIPPED WITHOUT SHIP_DATE
SELECT '10. status=SHIPPED but ship_date NULL' AS check_,
       invoice, reference, last_event_at
FROM jobs
WHERE status='SHIPPED' AND ship_date IS NULL
LIMIT 50;

-- 11. BREAKAGE WRITER HEALTH — breakage_events should match looker if writer exists
SELECT '11. breakage_events vs looker count mismatch' AS check_,
       (SELECT COUNT(*) FROM breakage_events WHERE occurred_at >= date('now','-7 days')) AS bevents_7d,
       (SELECT SUM(count_breakages) FROM looker_jobs WHERE sent_from_lab_date >= date('now','-7 days')) AS looker_breakages_7d;
