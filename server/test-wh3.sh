#!/bin/bash
TOKEN=$(grep ITEMPATH_TOKEN /Users/Shared/lab_assistant/.env | cut -d= -f2)

echo "=== ALL materials — counting stock by warehouse filter ==="

echo -n "WH1: "
curl -s "https://paireyewear.itempath.com/api/materials?limit=10000&warehouseId=8FB15DF9-8B63-423E-A5A3-D45ABBD2E79D" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=[m for m in d.get('materials',[]) if (m.get('currentQuantity') or 0)>0]
total=sum(m.get('currentQuantity',0) for m in items)
print(f'{len(items)} SKUs with stock, {int(total)} total units')
for m in items[:5]:
  print(f'  {m[\"name\"]}: {m[\"currentQuantity\"]}')
"

echo ""
echo -n "WH3: "
curl -s "https://paireyewear.itempath.com/api/materials?limit=10000&warehouseId=31EDF557-FFB0-463D-ADA5-ECA56CCD79C5" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=[m for m in d.get('materials',[]) if (m.get('currentQuantity') or 0)>0]
total=sum(m.get('currentQuantity',0) for m in items)
print(f'{len(items)} SKUs with stock, {int(total)} total units')
for m in items[:5]:
  print(f'  {m[\"name\"]}: {m[\"currentQuantity\"]}')
"

echo ""
echo -n "No filter: "
curl -s "https://paireyewear.itempath.com/api/materials?limit=10000" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=[m for m in d.get('materials',[]) if (m.get('currentQuantity') or 0)>0]
total=sum(m.get('currentQuantity',0) for m in items)
print(f'{len(items)} SKUs with stock, {int(total)} total units')
for m in items[:5]:
  print(f'  {m[\"name\"]}: {m[\"currentQuantity\"]}')
"
