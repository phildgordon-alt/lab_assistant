-- 004_holds.sql
--
-- SKU-level manual hold tracking. Phil's workflow: a defective lens batch
-- (or any other reason to pause picks of a specific SKU) is entered as a
-- hold; every active job whose lens_opc_r or lens_opc_l matches a held
-- SKU is auto-excluded from the aging dashboard until the hold is
-- released. This keeps SLA/outlier metrics from being polluted by
-- jobs that are intentionally paused.
--
-- One row per (sku, status='active') — UNIQUE constraint prevents
-- double-holding the same SKU at the same time. Released holds remain
-- in the table for forensic history.

CREATE TABLE IF NOT EXISTS holds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sku          TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  placed_by    TEXT    NOT NULL,
  placed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  released_at  TEXT,
  released_by  TEXT,
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  notes        TEXT
);

-- Only one active hold per SKU; same SKU can have many released rows in history
CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_active_unique
  ON holds(sku) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_holds_status     ON holds(status);
CREATE INDEX IF NOT EXISTS idx_holds_placed_at  ON holds(placed_at);
