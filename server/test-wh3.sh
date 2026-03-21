#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)
BASE="https://paireyewear.itempath.com/api"
AUTH="Authorization: Bearer $TOKEN"
WH1="8FB15DF9-8B63-423E-A5A3-D45ABBD2E79D"
WH3="31EDF557-FFB0-463D-ADA5-ECA56CCD79C5"

echo "=== Show Warehouse WH1 ==="
curl -s "$BASE/warehouses/$WH1" -H "$AUTH" | head -c 1000
echo ""
echo ""
echo "=== Show Warehouse WH3 ==="
curl -s "$BASE/warehouses/$WH3" -H "$AUTH" | head -c 1000
echo ""
