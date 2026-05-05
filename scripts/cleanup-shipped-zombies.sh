#!/bin/bash
# Cleanup the SHIPPED-status-drift zombies that hide WIP.
#
# Background — 2026-05-05:
# DVI WIP shows 3,240 jobs. Lab_Assistant `jobs` table shows 1,785 active.
# Gap = 1,455 jobs marked status='SHIPPED' in our table but with NULL ship_date
# AND current_stage at a real lab station (CUTTING, SURFACING, COATING, etc.).
# These are zombies — physically still being processed per their stage, but
# excluded from active WIP because of the status filter.
#
# Root cause (now fixed by accompanying code changes in same PR):
#   - dvi-trace.js:1004-1010 flipped in-memory job.status='SHIPPED' on any
#     SH-CONVEY station, then db.js:3361 downgrade-guard made it permanent
#   - oven-timer-server.js:131-136 self-heal flipped status without requiring
#     ship_date, leaving NULL ship_date rows
#   - db.js:3441 INSERT hardcoded 'SHIPPED' on initial XML insert regardless
#     of whether ship_date was present
#
# All three fixed in commit shipped with this script. After kickstart, no NEW
# zombies will be created. This script cleans up the historical pile.
#
# Per second-opinion review (data-pipeline-engineer 2026-05-05):
#   - Dev DB has 8,683 zombies, all sharing updated_at = 2026-04-16 02:42:04
#   - Single bad event (deploy/restart) created the entire pile — not ongoing
#   - All zombies have last_event_at IS NULL (never had a trace event after)
#   - 0 false-resurrection risk: none of these match a dvi_shipped_jobs row
#
# Critical guard: SQLite NULL >= datetime returns NULL (not TRUE), so the
# `last_event_at IS NULL` branch is REQUIRED to actually match these rows.
# Without it the UPDATE matches 0 rows and accomplishes nothing.
#
# Idempotent. Default dry-run; --apply to write.
#
# Usage:
#   bash scripts/cleanup-shipped-zombies.sh           # dry run
#   bash scripts/cleanup-shipped-zombies.sh --apply   # actually write

set -e

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB"
  exit 1
fi

echo "── Pre-cleanup state ──"
sqlite3 -readonly "$DB" "SELECT status, COUNT(*) AS rows FROM jobs GROUP BY status ORDER BY rows DESC;"

echo ""
echo "── Zombie candidates by stage (would be flipped to ACTIVE) ──"
sqlite3 -readonly "$DB" "SELECT current_stage, COUNT(*) AS zombies FROM jobs WHERE status='SHIPPED' AND ship_date IS NULL AND current_stage NOT IN ('SHIPPED', 'SHIPPING', 'CANCELED') AND (last_event_at IS NULL OR last_event_at >= datetime('now', '-30 days')) GROUP BY current_stage ORDER BY zombies DESC;"

TOTAL=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM jobs WHERE status='SHIPPED' AND ship_date IS NULL AND current_stage NOT IN ('SHIPPED', 'SHIPPING', 'CANCELED') AND (last_event_at IS NULL OR last_event_at >= datetime('now', '-30 days'));")

echo ""
echo "Total zombies to resurrect: $TOTAL"

if [ $APPLY -eq 0 ]; then
  echo ""
  echo "DRY RUN — no rows modified. To apply: re-run with --apply"
  exit 0
fi

echo ""
echo "── Applying UPDATE ──"
sqlite3 "$DB" "UPDATE jobs SET status='ACTIVE', updated_at=datetime('now') WHERE status='SHIPPED' AND ship_date IS NULL AND current_stage NOT IN ('SHIPPED', 'SHIPPING', 'CANCELED') AND (last_event_at IS NULL OR last_event_at >= datetime('now', '-30 days')); SELECT changes() AS rows_updated;"

echo ""
echo "── Post-cleanup state ──"
sqlite3 -readonly "$DB" "SELECT status, COUNT(*) AS rows FROM jobs GROUP BY status ORDER BY rows DESC;"

echo ""
echo "── New active by stage ──"
sqlite3 -readonly "$DB" "SELECT current_stage, COUNT(*) AS rows FROM jobs WHERE status IN ('ACTIVE','Active') GROUP BY current_stage ORDER BY rows DESC;"

echo ""
echo "Done. Refresh Overview — Total WIP should jump to ~3,100-3,400 (DVI ±5%)."
