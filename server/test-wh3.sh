#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)
BASE="https://paireyewear.itempath.com/api"
AUTH="Authorization: Bearer $TOKEN"

for ep in "locationContents" "locationcontents" "location_contents" "location-content" "locationContent" "contents" "storage-units" "storageUnits"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$ep?limit=1" -H "$AUTH")
  echo "$ep → $CODE"
done

echo ""
echo "=== Reports list ==="
curl -s "$BASE/reports?limit=5" -H "$AUTH" | head -c 800
echo ""

echo ""
echo "=== Storage Units ==="
curl -s "$BASE/storage-units?limit=2" -H "$AUTH" | head -c 500
echo ""
