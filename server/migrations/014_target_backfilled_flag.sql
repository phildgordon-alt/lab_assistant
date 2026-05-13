-- 014_target_backfilled_flag.sql
--
-- Phil 2026-05-13: faithful backfill marks rows it writes with
-- backfilled=1 so future inspection can distinguish synthesized
-- targets (computed against reconstructed EOD WIP) from live captures.
--
-- The faithful backfill walks job_events to reconstruct end-of-day
-- WIP for each historical workday, then calls the same compute*
-- functions the live writer uses to derive target. Numbers will be
-- close to but not identical to what a same-day live capture would
-- have produced — small differences come from:
--   - Late events that arrived after the day's last live capture
--     (now visible in the EOD reconstruction)
--   - Live captures using point-in-time WIP at capture hour, not EOD
--
-- These differences are intentional and bounded; the backfilled flag
-- lets us spot-check the differences without confusing them for
-- buggy data.

ALTER TABLE daily_ship_targets      ADD COLUMN backfilled INTEGER DEFAULT 0;
ALTER TABLE daily_coating_targets   ADD COLUMN backfilled INTEGER DEFAULT 0;
ALTER TABLE daily_surfacing_targets ADD COLUMN backfilled INTEGER DEFAULT 0;
