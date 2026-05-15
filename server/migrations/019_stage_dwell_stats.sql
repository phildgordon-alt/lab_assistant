-- Phil 2026-05-14 — empirical p50/p90 dwell time per stage.
--
-- Used by coating-target.js v4 and surfacing-target.js v3 to compute
-- "realistic arrivals today" — how many upstream jobs will physically
-- reach a downstream stage given empirical process times. Refreshed
-- hourly by oven-timer-server.js setInterval. See plan:
-- /Users/phil/.claude/plans/cheeky-wandering-hollerith.md.
--
-- Schema:
--   stage          — DVI stage code (SURFACING / BLOCKING / COATING / etc.)
--   window_days    — how many days back the stats were computed over (default 14)
--   sample_count   — number of dwell samples in the window
--   p50_minutes    — median dwell at this stage (minutes)
--   p90_minutes    — 90th-percentile dwell (minutes) — conservative estimator
--   computed_at    — unix ms timestamp of last refresh

CREATE TABLE IF NOT EXISTS stage_dwell_stats (
  stage          TEXT    NOT NULL,
  window_days    INTEGER NOT NULL DEFAULT 14,
  sample_count   INTEGER NOT NULL DEFAULT 0,
  p50_minutes    REAL,
  p90_minutes    REAL,
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (stage, window_days)
);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_stats_stage ON stage_dwell_stats(stage);
