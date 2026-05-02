#!/bin/bash
# Cleanup: delete phantom Power Pick rows from picks_history, then re-backfill
# with the corrected (PickWarehouseName IS NOT NULL) filter.
#
# Background — 2026-05-02 incident:
# Power Pick `History.Type=4` rows are doubled in source. Each pick is written
# twice — once as a request (MotiveType=5, qty=0, PickWarehouseName=NULL) and
# once on fulfillment (MotiveType=0, qty>0, PickWarehouseName populated).
# The pre-fix adapter pulled both, ingesting ~3.4 phantoms per real pick, which
# caused the Consumption tab to show Kardex picks 2-3x NetSuite (+183K YTD unit
# variance). Fix landed in same commit as this script: pollPicks() WHERE clause
# now adds AND PickWarehouseName IS NOT NULL.
#
# This script:
#   1. Counts phantom rows already in picks_history (source='powerpick' AND
#      (warehouse IS NULL OR warehouse='' OR qty=0))
#   2. Deletes them
#   3. Re-runs backfillRecentPicks(30) so any real picks that were dropped
#      (shouldn't be any — phantoms had different pick_ids than real picks —
#      but cheap insurance) are re-ingested via the corrected query
#   4. Verifies post-cleanup row count + earliest/latest dates
#
# Idempotent. Safe to run twice. INSERT OR IGNORE on pick_id makes the
# re-backfill harmless.

set -e

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
URL="${LAB_SERVER_URL:-http://localhost:3002}"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB"
  exit 1
fi

echo "── Pre-cleanup state ──"
sqlite3 -readonly "$DB" "SELECT COUNT(*) AS total_powerpick_rows, SUM(CASE WHEN warehouse IS NULL OR warehouse='' OR qty=0 THEN 1 ELSE 0 END) AS phantom_rows, SUM(CASE WHEN warehouse IS NOT NULL AND warehouse<>'' AND qty>0 THEN 1 ELSE 0 END) AS real_rows FROM picks_history WHERE source='powerpick';"

echo ""
echo "── Deleting phantom rows ──"
sqlite3 "$DB" "DELETE FROM picks_history WHERE source='powerpick' AND (warehouse IS NULL OR warehouse='' OR qty=0); SELECT changes() AS deleted_rows;"

echo ""
echo "── Re-running 30-day backfill with corrected query ──"
curl -s -X POST "${URL}/api/powerpick/backfill?days=30"; echo

echo ""
echo "── Post-cleanup state ──"
sqlite3 -readonly "$DB" "SELECT COUNT(*) AS total_powerpick_rows, COUNT(DISTINCT order_id) AS distinct_invoices, MIN(completed_at) AS earliest, MAX(completed_at) AS latest FROM picks_history WHERE source='powerpick';"

echo ""
echo "── Daily counts (last 14 days, powerpick only) ──"
sqlite3 -readonly "$DB" "SELECT substr(completed_at,1,10) AS pt_date, COUNT(*) AS picks FROM picks_history WHERE source='powerpick' AND completed_at >= datetime('now','-14 days') GROUP BY pt_date ORDER BY pt_date;"

echo ""
echo "If picks/day numbers are now 1,500–4,000 (vs the previous ballooned 7,000+),"
echo "the fix worked. Compare to NetSuite by opening Inventory > Consumption."
