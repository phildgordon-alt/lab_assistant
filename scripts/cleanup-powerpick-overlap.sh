#!/bin/bash
# Cleanup: delete Power Pick picks_history rows that overlap the ItemPath era.
#
# Background — 2026-05-02:
# Power Pick adapter shipped 2026-05-01 with ITEMPATH_PICKSYNC_DISABLED=true.
# To backfill missing lens_type, we ran backfillRecentPicks(30) which pulled
# Power Pick `History` rows from April 1 onward — but ItemPath REST had
# already been writing picks_history rows for that same April window.
#
# pick_id formats differ: ItemPath uses its own ID, Power Pick uses
# `pp-<HistoryId>`. Same physical pick → two rows in picks_history.
# Inventory > Consumption COUNTs all rows regardless of source → 2x inflation
# vs NetSuite during the overlap window.
#
# Fix: delete powerpick rows where completed_at < '2026-05-01'. Before May 1
# the canonical source was ItemPath (live + tx + backfill); after May 1 the
# canonical source is Power Pick alone.
#
# Idempotent. No effect if already cleaned (deletes 0 rows).

set -e

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
CUTOFF="${CUTOFF:-2026-05-01}"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB"
  exit 1
fi

echo "── Pre-cleanup state ──"
sqlite3 -readonly "$DB" "SELECT COUNT(*) AS pp_total, SUM(CASE WHEN substr(completed_at,1,10) < '$CUTOFF' THEN 1 ELSE 0 END) AS pp_pre_cutoff, SUM(CASE WHEN substr(completed_at,1,10) >= '$CUTOFF' THEN 1 ELSE 0 END) AS pp_post_cutoff FROM picks_history WHERE source='powerpick';"

echo ""
echo "── Daily counts BEFORE cleanup (last 14 days, all sources, lens+frame) ──"
sqlite3 -readonly "$DB" "SELECT substr(completed_at,1,10) AS pt_date, COUNT(*) AS rows, SUM(CASE WHEN source='powerpick' THEN 1 ELSE 0 END) AS pp_rows, SUM(CASE WHEN source IN ('live','tx','backfill','recovered') OR source IS NULL THEN 1 ELSE 0 END) AS ip_rows FROM picks_history WHERE completed_at >= datetime('now','-14 days') GROUP BY pt_date ORDER BY pt_date;"

echo ""
echo "── Deleting powerpick rows with completed_at < $CUTOFF ──"
sqlite3 "$DB" "DELETE FROM picks_history WHERE source='powerpick' AND substr(completed_at,1,10) < '$CUTOFF'; SELECT changes() AS deleted_rows;"

echo ""
echo "── Post-cleanup state ──"
sqlite3 -readonly "$DB" "SELECT COUNT(*) AS pp_total, COUNT(DISTINCT order_id) AS pp_invoices, MIN(completed_at) AS earliest, MAX(completed_at) AS latest FROM picks_history WHERE source='powerpick';"

echo ""
echo "── Daily counts AFTER cleanup (last 14 days) ──"
sqlite3 -readonly "$DB" "SELECT substr(completed_at,1,10) AS pt_date, COUNT(*) AS rows, SUM(CASE WHEN source='powerpick' THEN 1 ELSE 0 END) AS pp_rows, SUM(CASE WHEN source IN ('live','tx','backfill','recovered') OR source IS NULL THEN 1 ELSE 0 END) AS ip_rows FROM picks_history WHERE completed_at >= datetime('now','-14 days') GROUP BY pt_date ORDER BY pt_date;"

echo ""
echo "Refresh Inventory > Consumption — Kardex column should now align with NetSuite for the April window."
