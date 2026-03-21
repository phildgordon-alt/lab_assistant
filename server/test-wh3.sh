#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)
echo "=== WH3 Materials (first 2) ==="
curl -s "https://paireyewear.itempath.com/api/materials?limit=2&warehouseId=31EDF557-FFB0-463D-ADA5-ECA56CCD79C5" \
  -H "Authorization: Bearer $TOKEN"
echo ""
echo ""
echo "=== WH1 Materials (first 2) ==="
curl -s "https://paireyewear.itempath.com/api/materials?limit=2&warehouseId=8FB15DF9-8B63-423E-A5A3-D45ABBD2E79D" \
  -H "Authorization: Bearer $TOKEN"
echo ""
