-- 003_jobs_triggers_fix_raise.sql
--
-- Hotfix for migration 002. The original triggers used string concatenation
-- inside RAISE() to embed OLD.status / NEW.status into the error message:
--
--     SELECT RAISE(ABORT, 'jobs_update_terminal_status_lock: ... '
--                         || OLD.status || ' to ' || NEW.status);
--
-- That is accepted by newer SQLite (which is what better-sqlite3 ships with),
-- so the migration applied cleanly on the lab server. But the SQLite version
-- bundled with the system `sqlite3` CLI on the Mac Studio is older and parses
-- RAISE() arguments as a `name` (string-literal-only), not an expression.
-- Result: any sqlite3 CLI query against the prod DB returned
--   "malformed database schema (jobs_update_terminal_status_lock) - near '||'"
-- which broke backups, ad-hoc queries, and anything else that doesn't go
-- through better-sqlite3.
--
-- Fix: drop the offending trigger and recreate it with a static error
-- message. The guard still ABORTs writes that would downgrade a terminal
-- status; we just lose the dynamic OLD/NEW values in the error string.
-- Whoever sees the abort can recover those from the SQL that triggered it.
--
-- Also rewriting the two zombie_guard triggers as static — they didn't use
-- concatenation, but rebuilding them keeps the migration self-contained and
-- gives every trigger a single canonical definition.

DROP TRIGGER IF EXISTS jobs_insert_zombie_guard;
DROP TRIGGER IF EXISTS jobs_update_zombie_guard;
DROP TRIGGER IF EXISTS jobs_update_terminal_status_lock;

CREATE TRIGGER jobs_insert_zombie_guard
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.current_stage = 'SHIPPED' AND (NEW.ship_date IS NULL OR NEW.ship_date = '')
BEGIN
  SELECT RAISE(ABORT, 'jobs_insert_zombie_guard: refusing INSERT of SHIPPED row without ship_date');
END;

CREATE TRIGGER jobs_update_zombie_guard
BEFORE UPDATE ON jobs
FOR EACH ROW
WHEN NEW.current_stage = 'SHIPPED' AND (NEW.ship_date IS NULL OR NEW.ship_date = '')
BEGIN
  SELECT RAISE(ABORT, 'jobs_update_zombie_guard: refusing UPDATE that would leave SHIPPED row with no ship_date');
END;

CREATE TRIGGER jobs_update_terminal_status_lock
BEFORE UPDATE ON jobs
FOR EACH ROW
WHEN OLD.status IN ('SHIPPED', 'CANCELED')
 AND NEW.status IS NOT NULL
 AND NEW.status != OLD.status
BEGIN
  SELECT RAISE(ABORT, 'jobs_update_terminal_status_lock: refusing terminal status downgrade');
END;
