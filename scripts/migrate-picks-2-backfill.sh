#!/bin/bash
# Migration step 2/4 — backfill Power Pick to its full historical depth.
# Calls the local server's /api/powerpick/backfill-history with start=2024-12-31.
# Long-running: ~30-60 min for the full 970K-row, 17-month replay.
#
# Idempotent — INSERT OR IGNORE on pick_id dedupes. Safe to interrupt and re-run.
#
# Live cursor (`lastSyncCreationdate`) is NOT touched by this — live polling
# continues writing new picks at its current 30-second cadence throughout.
#
# Usage:
#   bash scripts/migrate-picks-2-backfill.sh           # default: from 2024-12-31 to now
#   START=2025-06-01 END=2025-12-31 bash ...          # custom window

set -e

URL="${LAB_SERVER_URL:-http://localhost:3002}"
START="${START:-2024-12-31T00:00:00Z}"
END="${END:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"

echo "── Pre-backfill state ──"
sqlite3 -readonly "$DB" "SELECT source, COUNT(*) AS rows FROM picks_history GROUP BY source ORDER BY rows DESC;"

echo ""
echo "── Triggering backfill: $START → $END ──"
echo "  (long-running — server logs will show per-chunk progress in lab-server.log)"
echo ""

# The endpoint runs synchronously and returns when done. Use --max-time 7200 (2h)
# in case there's a 60-min run. tail server log in another window to watch progress.
curl --max-time 7200 -s -X POST "${URL}/api/powerpick/backfill-history?start=${START}&end=${END}"
echo ""
echo ""

echo "── Post-backfill state ──"
sqlite3 -readonly "$DB" "SELECT source, COUNT(*) AS rows, MIN(completed_at) AS earliest, MAX(completed_at) AS latest FROM picks_history GROUP BY source ORDER BY rows DESC;"

echo ""
echo "Next: bash scripts/migrate-picks-3-reconcile.sh"
echo "  (DO NOT run step 4 until step 3 shows PowerPick within ±5% of NetSuite)"
