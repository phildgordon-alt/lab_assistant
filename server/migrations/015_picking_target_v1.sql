-- 015_picking_target_v1.sql
--
-- Phil 2026-05-13 evening: 6th department goal — Picking / Lens Kitchen.
-- Where everything gets picked from Kardex to feed the SV and Surfacing
-- lines. The pick goal is critical because if picking falls behind, every
-- downstream stage starves and SLAs slip.
--
-- Phil's stated formula intent: "calculated from incoming jobs in the
-- WIP and how many they need to get out and pick to put into the WIP to
-- make sure that we can get things done on time."
--
-- Shape C formula (planner recommendation, Phil approved):
--
--   unpickedBacklog  = distinct invoices currently in the lab that haven't
--                      been picked yet (no row in picks_history matching
--                      their invoice AND no downstream job_events at any
--                      stage past PICKING)
--   intakeProjection = 14-workday rolling avg of distinct invoices whose
--                      first job_events.event_ts is in the window
--   target           = unpickedBacklog + intakeProjection (workdays only)
--
-- No separate rollover — the backlog term carries that role naturally.
-- Yesterday's missed picks show up as today's backlog. Self-correcting.
-- rollover_in column kept at 0 for shape parity with the other dept
-- target tables; reserved for a future formula version if needed.
--
-- IMPORTANT — unit is DISTINCT INVOICES, not pick events. The other dept
-- goals all count invoices/day; picking matches for consistency. The
-- per-warehouse event count (~2,200/day) stays on the "Picks Today by
-- Warehouse" tile as an operational stat — different measure.

CREATE TABLE IF NOT EXISTS daily_picking_targets (
  date                  TEXT PRIMARY KEY,
  is_workday            INTEGER DEFAULT 1,
  unpicked_backlog      INTEGER DEFAULT 0,  -- distinct invoices waiting to be picked
  intake_projection     INTEGER DEFAULT 0,  -- 14-workday avg of daily new-invoice intake
  capacity_estimate     INTEGER DEFAULT 0,  -- 14-workday avg of daily picked-invoice count
  rollover_in           INTEGER DEFAULT 0,  -- reserved; current formula folds rollover into backlog
  total_target          INTEGER DEFAULT 0,
  picked_actual         INTEGER DEFAULT 0,  -- distinct invoices picked today
  variance              INTEGER DEFAULT 0,
  formula_version       INTEGER DEFAULT 1,
  backfilled            INTEGER DEFAULT 0,
  captured_at           TEXT DEFAULT (datetime('now')),
  finalized_at          TEXT
);

INSERT OR IGNORE INTO lab_planning_config (key, value, description) VALUES
  ('picking_intake_window_days', 14.0, 'Rolling window (workdays) for picking intake projection. 14 = ~3 weeks. Mirrors shipping/coating/surfacing intake_window_days for cross-stage trend comparison.'),
  ('picking_rollover_layers',    1.0,  'Reserved. v1 formula folds rollover into unpicked_backlog — this knob is preserved for future formula versions that separate the two terms.'),
  ('picking_formula_version',    1.0,  'Active picking target formula version. 1 = unpicked_backlog + intake_projection.');
