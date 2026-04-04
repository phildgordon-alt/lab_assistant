#!/bin/bash
# Safe restart — kills ALL Lab Assistant processes, restarts both servers via launchd
# Use this instead of manual launchctl stop/start

echo "=== Killing all Lab Assistant node processes ==="
pkill -f "node.*oven-timer-server" 2>/dev/null
pkill -f "node.*gateway.*index" 2>/dev/null
pkill -f "tsx.*index.ts" 2>/dev/null
sleep 2

# Force kill any remaining
REMAINING=$(pgrep -f "node.*(oven-timer-server|gateway|index\.ts)" | wc -l | tr -d ' ')
if [ "$REMAINING" != "0" ]; then
  echo "Force killing $REMAINING stubborn processes..."
  pkill -9 -f "node.*(oven-timer-server|gateway|index\.ts)" 2>/dev/null
  sleep 1
fi

echo "=== Starting Lab Server (port 3002) ==="
launchctl start com.paireyewear.labassistant.server
echo "=== Starting Gateway (port 3001) ==="
launchctl start com.paireyewear.labassistant.gateway
sleep 3

# Verify
SERVER=$(pgrep -f "node.*oven-timer-server" | wc -l | tr -d ' ')
GATEWAY=$(pgrep -f "node.*(gateway|index\.ts)" | wc -l | tr -d ' ')
echo ""
echo "Lab Server processes: $SERVER (expect 1)"
echo "Gateway processes: $GATEWAY (expect 1-2)"

if [ "$SERVER" = "1" ]; then
  echo "Server OK"
  curl -s http://localhost:3002/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Health: {d[\"ok\"]}, Port: {d[\"port\"]}')" 2>/dev/null
else
  echo "WARNING: Server not running"
fi
