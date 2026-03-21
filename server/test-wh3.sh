#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)
BASE="https://paireyewear.itempath.com/api"
AUTH="Authorization: Bearer $TOKEN"

echo "=== Location Contents (first 5) ==="
curl -s "$BASE/location_contents?limit=5" -H "$AUTH"
echo ""
echo ""
echo "=== Location Content Breakdowns (first 5) ==="
curl -s "$BASE/location_content_breakdowns?limit=5" -H "$AUTH"
echo ""
