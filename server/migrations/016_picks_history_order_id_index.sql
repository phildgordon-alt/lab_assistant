-- 016_picks_history_order_id_index.sql
--
-- Phil 2026-05-13 evening: server hung after deploying the picking dept
-- batch. Root cause: getUnpickedBacklogCount in server/domain/picking-
-- target.js runs a NOT EXISTS subquery against picks_history.order_id
-- for every active job. picks_history has no index on order_id (existing
-- indexes are on sku, completed_at, recorded_at, and pick_id) — so each
-- NOT EXISTS triggers a full table scan of 132k rows. For ~19k active
-- jobs × 132k rows = ~2.5B row comparisons per capture run.
--
-- SQLite is synchronous and better-sqlite3 blocks the Node event loop;
-- once captureDailyPickingTarget fires at boot+2:12 the whole server
-- stops responding to HTTP for the duration of the query.
--
-- Fix: index picks_history.order_id. Reduces each NOT EXISTS lookup
-- from O(N) to O(log N) — total scan cost drops from N×M to N×log(M).
-- Live capture goes from minutes to milliseconds.

CREATE INDEX IF NOT EXISTS idx_picks_hist_order_id
  ON picks_history(order_id);
