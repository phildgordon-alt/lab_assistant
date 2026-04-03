#!/bin/bash
source /Users/Shared/lab_assistant/.env
curl -s --max-time 30 "$ITEMPATH_URL/api/order_lines?directionType=2&status=processed&limit=1" -H "Authorization: Bearer $ITEMPATH_TOKEN" | head -5
