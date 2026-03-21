#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)
BASE="https://paireyewear.itempath.com/api"
AUTH="Authorization: Bearer $TOKEN"
WH3="31EDF557-FFB0-463D-ADA5-ECA56CCD79C5"
WH1="8FB15DF9-8B63-423E-A5A3-D45ABBD2E79D"
# Pick a material with stock
MAT="DB610C7E-2520-431B-9C7B-D2D5751FF0E3"

echo "=== Try /api/stock ==="
curl -s "$BASE/stock?limit=2" -H "$AUTH" | head -c 200
echo ""

echo "=== Try /api/inventory ==="
curl -s "$BASE/inventory?limit=2" -H "$AUTH" | head -c 200
echo ""

echo "=== Try /api/materials/{id}/locations ==="
curl -s "$BASE/materials/$MAT/locations?limit=5" -H "$AUTH" | head -c 500
echo ""

echo "=== Try /api/materials/{id}/stock ==="
curl -s "$BASE/materials/$MAT/stock" -H "$AUTH" | head -c 500
echo ""

echo "=== Try /api/warehouses/{WH1}/materials?limit=2 ==="
curl -s "$BASE/warehouses/$WH1/materials?limit=2" -H "$AUTH" | head -c 500
echo ""

echo "=== Try /api/warehouses/{WH1}/stock?limit=2 ==="
curl -s "$BASE/warehouses/$WH1/stock?limit=2" -H "$AUTH" | head -c 500
echo ""

echo "=== Try /api/locations?materialId={MAT} ==="
curl -s "$BASE/locations?materialId=$MAT&limit=5" -H "$AUTH" | head -c 500
echo ""

echo "=== Try /api/material-locations?limit=2 ==="
curl -s "$BASE/material-locations?limit=2" -H "$AUTH" | head -c 500
echo ""
