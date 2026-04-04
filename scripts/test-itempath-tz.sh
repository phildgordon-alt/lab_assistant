#!/bin/bash
source /Users/Shared/lab_assistant/.env

echo "=== Test 1: Local time (no Z) ==="
echo "Querying: modifiedDate[gte]=2026-04-04T12:00:00"
time curl -s --max-time 30 "$ITEMPATH_URL/api/order_lines?directionType=2&status=processed&limit=1&modifiedDate%5Bgte%5D=2026-04-04T12:00:00" -H "Authorization: Bearer $ITEMPATH_TOKEN" | head -3
echo ""

echo "=== Test 2: UTC time (with Z) ==="
echo "Querying: modifiedDate[gte]=2026-04-04T19:00:00.000Z"
time curl -s --max-time 30 "$ITEMPATH_URL/api/order_lines?directionType=2&status=processed&limit=1&modifiedDate%5Bgte%5D=2026-04-04T19:00:00.000Z" -H "Authorization: Bearer $ITEMPATH_TOKEN" | head -3
echo ""
