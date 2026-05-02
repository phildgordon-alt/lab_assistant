#!/bin/bash
# Migration step 4/4 — delete all non-Power-Pick rows from picks_history.
# This is the destructive step. Only run AFTER step 3 passes (reconciliation
# CSV shows PowerPick within ±5% of NetSuite for ≥80% of days).
#
# Rollback: restore the snapshot from step 1.
#
# After this completes:
#   - Power Pick is the sole source for picks_history
#   - ItemPath pick paths stay dormant (ITEMPATH_PICKSYNC_DISABLED=true) for
#     one month per Phil's directive (2026-05-02 → 2026-06-02), then removed
#   - Inventory > Consumption tab Kardex column should match NetSuite ±5%
#   - Sample test: invoice 446273 SKU 4800150940 should return exactly 1 row
#
# Usage:
#   bash scripts/migrate-picks-4-delete.sh
#   bash scripts/migrate-picks-4-delete.sh --yes   # skip confirmation prompt

set -e

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB"; exit 1
fi

echo "── Pre-delete state ──"
sqlite3 -readonly "$DB" "SELECT source, COUNT(*) AS rows FROM picks_history GROUP BY source ORDER BY rows DESC;"

echo ""
echo "── About to DELETE every picks_history row WHERE source != 'powerpick' OR source IS NULL ──"
TO_DELETE=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM picks_history WHERE source IS NULL OR source != 'powerpick';")
echo "  Rows to delete: $TO_DELETE"
echo ""

if [ "${1:-}" != "--yes" ]; then
  read -p "Type 'delete' to proceed (anything else aborts): " CONFIRM
  if [ "$CONFIRM" != "delete" ]; then
    echo "Aborted."; exit 0
  fi
fi

echo ""
echo "── Deleting… ──"
sqlite3 "$DB" "DELETE FROM picks_history WHERE source IS NULL OR source != 'powerpick'; SELECT changes() AS deleted_rows;"

echo ""
echo "── Post-delete state ──"
sqlite3 -readonly "$DB" "SELECT source, COUNT(*) AS rows, MIN(completed_at) AS earliest, MAX(completed_at) AS latest FROM picks_history GROUP BY source;"

echo ""
echo "── Sample verification — invoice 446273 SKU 4800150940 ──"
sqlite3 -readonly "$DB" "SELECT pick_id, source, qty, warehouse, completed_at FROM picks_history WHERE order_id = '446273' AND sku = '4800150940';"

echo ""
echo "Migration complete."
echo ""
echo "Next steps:"
echo "  1. Refresh Inventory > Consumption — Kardex should now match NetSuite ±5%"
echo "  2. Spot-check Picks tab, Activity tab, Analytics tab — should render normally"
echo "  3. Watch /api/watchdog/state for any adapter going stale or erroring"
echo "  4. The data-health-check upper-bound regression guard runs at next 1:30 AM"
echo ""
echo "Schedule: in one month (2026-06-02), the dormant ItemPath pick paths get"
echo "removed from server/itempath-adapter.js per Phil's directive. /schedule"
echo "an agent or set a calendar reminder."
