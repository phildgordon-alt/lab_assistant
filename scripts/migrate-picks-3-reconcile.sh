#!/bin/bash
# Migration step 3/4 — numeric reconciliation BEFORE the destructive delete.
# Compares per-day picks_history Kardex column three ways:
#   - ItemPath-only (sources: live, tx, backfill, recovered, NULL)
#   - PowerPick-only (source: powerpick)
#   - NetSuite ground truth (Looker — read via /api/usage/consumption)
#
# Outputs CSV to /tmp/migrate-picks-reconcile-YYYY-MM-DD.csv and prints a
# summary table to stdout. Exits non-zero if PowerPick is NOT within ±5% of
# NetSuite for ≥80% of in-window days — that's the gating criterion to
# proceed to step 4.
#
# Window: 30 days back from today.
#
# Usage:
#   bash scripts/migrate-picks-3-reconcile.sh

set -e

DB="${LAB_DB:-/Users/Shared/lab_assistant/data/lab_assistant.db}"
URL="${LAB_SERVER_URL:-http://localhost:3002}"
STAMP=$(date '+%Y-%m-%d')
CSV="/tmp/migrate-picks-reconcile-${STAMP}.csv"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB"
  exit 1
fi

FROM=$(date -v-30d '+%Y-%m-%d' 2>/dev/null || date -d '30 days ago' '+%Y-%m-%d')
TO=$(date '+%Y-%m-%d')

echo "── Reconciliation window: $FROM → $TO ──"
echo "── Output CSV: $CSV ──"
echo ""

# 1. Pull NetSuite numbers via the existing consumption endpoint
echo "Fetching NetSuite consumption from $URL/api/usage/consumption…"
NS_JSON=$(curl --max-time 60 -s "${URL}/api/usage/consumption?from=${FROM}&to=${TO}")
if [ -z "$NS_JSON" ] || [ "$NS_JSON" = "null" ]; then
  echo "ERROR: NetSuite endpoint returned empty — abort"; exit 2
fi

# 2. Pull picks_history three ways (NULL/itempath, powerpick, total) per day
echo "Computing picks_history splits per day…"
sqlite3 -header -csv "$DB" "
  WITH days AS (
    SELECT substr(completed_at,1,10) AS date,
           SUM(CASE WHEN source IN ('live','tx','backfill','recovered') OR source IS NULL THEN 1 ELSE 0 END) AS itempath_rows,
           SUM(CASE WHEN source = 'powerpick' THEN 1 ELSE 0 END) AS powerpick_rows,
           COUNT(*) AS total_rows
    FROM picks_history
    WHERE substr(completed_at,1,10) >= '$FROM' AND substr(completed_at,1,10) <= '$TO'
    GROUP BY substr(completed_at,1,10)
  )
  SELECT date, itempath_rows, powerpick_rows, total_rows FROM days ORDER BY date;
" > "${CSV}.picks"

# 3. Combine with NetSuite numbers via Node (jq is optional, Node is guaranteed)
node -e "
  const fs = require('fs');
  const ns = JSON.parse(process.argv[1]);
  const nsByDate = {};
  for (const d of (ns.daily || [])) nsByDate[d.date] = d.netsuite || 0;

  const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
  const header = lines.shift();
  const out = ['date,itempath_rows,powerpick_rows,total_rows,netsuite,pp_vs_ns_ratio,pp_within_5pct'];
  let inWindow = 0, withinTol = 0;
  for (const line of lines) {
    const [date, ip, pp, tot] = line.split(',');
    const ns = nsByDate[date] || 0;
    if (ns === 0) { out.push(\`\${date},\${ip},\${pp},\${tot},0,,\`); continue; }
    const ratio = (parseInt(pp,10) / ns).toFixed(3);
    const within = (Math.abs(parseInt(pp,10) - ns) / ns) <= 0.05 ? 'YES' : 'no';
    out.push(\`\${date},\${ip},\${pp},\${tot},\${ns},\${ratio},\${within}\`);
    inWindow++;
    if (within === 'YES') withinTol++;
  }
  fs.writeFileSync(process.argv[3], out.join('\n') + '\n');
  const pct = inWindow ? Math.round(100 * withinTol / inWindow) : 0;
  console.log('');
  console.log(\`Days in window: \${inWindow}\`);
  console.log(\`PowerPick within ±5% of NetSuite: \${withinTol}/\${inWindow} (\${pct}%)\`);
  console.log(\`Gating criterion (≥80%): \${pct >= 80 ? 'PASS' : 'FAIL'}\`);
  process.exit(pct >= 80 ? 0 : 3);
" "$NS_JSON" "${CSV}.picks" "$CSV"

CODE=$?
rm -f "${CSV}.picks"

echo ""
echo "── CSV written to $CSV ──"
echo ""
column -t -s, "$CSV" | head -40
echo ""

if [ $CODE -eq 0 ]; then
  echo "RECONCILIATION PASSED. Safe to proceed:"
  echo "  bash scripts/migrate-picks-4-delete.sh"
else
  echo "RECONCILIATION FAILED (PowerPick not within ±5% of NetSuite for enough days)."
  echo "DO NOT run step 4. Investigate the days marked 'no' in $CSV before proceeding."
  echo "Common causes:"
  echo "  - PowerPick backfill incomplete — re-run step 2 with the missing window"
  echo "  - PowerPick has a different definition of 'pick' than NetSuite for some product line"
  echo "  - NetSuite Looker data has its own gap"
  exit $CODE
fi
