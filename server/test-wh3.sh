#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)

echo "=== WH1 first 3 with qty > 0 ==="
curl -s "https://paireyewear.itempath.com/api/materials?limit=100&warehouseId=8FB15DF9-8B63-423E-A5A3-D45ABBD2E79D" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=[m for m in d.get('materials',[]) if (m.get('currentQuantity') or 0)>0]
for m in items[:3]:
  print(f\"  {m['name']}: qty={m['currentQuantity']}\")
print(f'  ({len(items)} with stock out of {len(d.get(\"materials\",[]))} total)')
"

echo ""
echo "=== WH3 first 3 with qty > 0 ==="
curl -s "https://paireyewear.itempath.com/api/materials?limit=100&warehouseId=31EDF557-FFB0-463D-ADA5-ECA56CCD79C5" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=[m for m in d.get('materials',[]) if (m.get('currentQuantity') or 0)>0]
for m in items[:3]:
  print(f\"  {m['name']}: qty={m['currentQuantity']}\")
print(f'  ({len(items)} with stock out of {len(d.get(\"materials\",[]))} total)')
"

echo ""
echo "=== NO warehouse filter first 3 with qty > 0 ==="
curl -s "https://paireyewear.itempath.com/api/materials?limit=100" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=[m for m in d.get('materials',[]) if (m.get('currentQuantity') or 0)>0]
for m in items[:3]:
  print(f\"  {m['name']}: qty={m['currentQuantity']}\")
print(f'  ({len(items)} with stock out of {len(d.get(\"materials\",[]))} total)')
"
