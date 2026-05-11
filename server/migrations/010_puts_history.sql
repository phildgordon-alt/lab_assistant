-- 010_puts_history.sql
--
-- Phase 2 of the ItemPath → Power Pick migration. Picks_history was
-- canonicalized on Power Pick in 2026-05-01 (Phase 1). Puts stayed on
-- ItemPath because they have no downstream lens_type derivation
-- dependency — but the ItemPath puts feed is noisy enough that the
-- daily-puts tile has been showing 21k+ on busy days (sum of
-- quantityConfirmed rather than event count).
--
-- This migration creates puts_history mirroring picks_history. The
-- Power Pick adapter polls History table Type=1 (operator restocking
-- puts, e.g. "ManualPut-LAPTOP-...") and writes per-event rows with
-- source='powerpick'. Downstream tile reads count rows, not qty.
--
-- Schema choices mirror picks_history exactly so future queries can
-- treat both tables interchangeably (e.g. for "all Kardex activity
-- today" rollups). order_id stores the freeform MasterorderName
-- (e.g. "ManualPut-LAPTOP-12") since puts have no DVI order linkage.

CREATE TABLE IF NOT EXISTS puts_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  put_id        TEXT,
  order_id      TEXT,          -- MasterorderName (freeform — not a join key)
  sku           TEXT,
  name          TEXT,
  qty           REAL,
  put_qty       REAL,
  warehouse     TEXT,
  completed_at  TEXT,
  source        TEXT,
  recorded_at   TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puts_hist_put_id    ON puts_history(put_id);
CREATE INDEX        IF NOT EXISTS idx_puts_hist_sku       ON puts_history(sku);
CREATE INDEX        IF NOT EXISTS idx_puts_hist_completed ON puts_history(completed_at);
CREATE INDEX        IF NOT EXISTS idx_puts_hist_source    ON puts_history(source);
CREATE INDEX        IF NOT EXISTS idx_puts_hist_warehouse ON puts_history(warehouse);
