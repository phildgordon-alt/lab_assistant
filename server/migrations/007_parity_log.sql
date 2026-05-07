-- 007_parity_log.sql
--
-- Daily ItemPath ↔ Power Pick inventory parity check log. The lab
-- server runs scripts/migration-phase0-parity-inventory.js once per
-- day at ~5am Pacific (before the lab shift starts, when both
-- sources are fully synced and polling lag is irrelevant) and writes
-- the result here. Streak counter computed from this table; 7
-- consecutive PASS days unblock Phase 1 of the ItemPath migration.

CREATE TABLE IF NOT EXISTS parity_inventory_log (
  check_date    TEXT PRIMARY KEY,            -- 'YYYY-MM-DD' lab-local
  passed        INTEGER NOT NULL,            -- 1 = pass, 0 = fail
  grand_pct     REAL,                         -- |Δ| as % of ItemPath total
  max_delta     INTEGER,                      -- largest single-SKU |Δ| in sample
  diffs         INTEGER,                      -- count of differing SKUs in sample
  only_pp       INTEGER,                      -- SKUs only in Power Pick
  only_ip       INTEGER,                      -- SKUs only in ItemPath
  pp_grand      INTEGER,                      -- Power Pick total qty
  ip_grand      INTEGER,                      -- ItemPath total qty
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parity_passed ON parity_inventory_log(passed, check_date);
