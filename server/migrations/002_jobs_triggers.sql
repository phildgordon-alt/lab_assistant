-- 002_jobs_triggers.sql
--
-- Step 4 of Task #19: engine-level guards that reject writes producing
-- zombie SHIPPED rows or terminal-status downgrades. Defense in depth —
-- jobs-repo.js already enforces these via the contract, but a future
-- bypass (a one-shot script, a manual sqlite3 session, a new code path
-- that misses the repo) would slip past app-layer validation. SQLite
-- triggers run at engine level and refuse the write regardless of caller.
--
-- Two triggers each on INSERT and UPDATE:
--   1. zombie_guard         — refuse current_stage='SHIPPED' with ship_date IS NULL
--   2. terminal_status_lock — refuse status downgrade from SHIPPED/CANCELED
--
-- The terminal-stage guard is intentionally strict: once SHIPPED or
-- CANCELED, status NEVER changes. Phil's call (today's earlier
-- conversation): no override, no force flag. If a row is wrongly stuck
-- terminal, the fix is to identify the cause and resolve at the source —
-- not let trace silently revert it.

-- ── INSERT-time guards ──────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS jobs_insert_zombie_guard
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.current_stage = 'SHIPPED' AND (NEW.ship_date IS NULL OR NEW.ship_date = '')
BEGIN
  SELECT RAISE(ABORT, 'jobs_insert_zombie_guard: refusing INSERT of SHIPPED row without ship_date');
END;

-- ── UPDATE-time guards ──────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS jobs_update_zombie_guard
BEFORE UPDATE ON jobs
FOR EACH ROW
WHEN NEW.current_stage = 'SHIPPED' AND (NEW.ship_date IS NULL OR NEW.ship_date = '')
BEGIN
  SELECT RAISE(ABORT, 'jobs_update_zombie_guard: refusing UPDATE that would leave SHIPPED row with no ship_date');
END;

CREATE TRIGGER IF NOT EXISTS jobs_update_terminal_status_lock
BEFORE UPDATE ON jobs
FOR EACH ROW
WHEN OLD.status IN ('SHIPPED', 'CANCELED')
 AND NEW.status IS NOT NULL
 AND NEW.status != OLD.status
BEGIN
  SELECT RAISE(ABORT, 'jobs_update_terminal_status_lock: refusing status downgrade from ' || OLD.status || ' to ' || NEW.status);
END;
