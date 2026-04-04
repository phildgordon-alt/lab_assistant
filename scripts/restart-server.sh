#!/bin/bash
# Safe server restart — kills ALL node server processes first, then starts via launchd
# Use this instead of manual launchctl stop/start

echo "Killing all oven-timer-server processes..."
pkill -f "node.*oven-timer-server" 2>/dev/null
sleep 2

# Verify clean
REMAINING=$(pgrep -f "node.*oven-timer-server" | wc -l | tr -d ' ')
if [ "$REMAINING" != "0" ]; then
  echo "Force killing $REMAINING stubborn processes..."
  pkill -9 -f "node.*oven-timer-server" 2>/dev/null
  sleep 1
fi

echo "Starting via launchd..."
launchctl start com.paireyewear.labassistant.server
sleep 3

# Verify exactly one process
COUNT=$(pgrep -f "node.*oven-timer-server" | wc -l | tr -d ' ')
echo "Server processes running: $COUNT"

if [ "$COUNT" = "1" ]; then
  echo "OK — single server instance running"
  curl -s http://localhost:3002/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Health: {d[\"ok\"]}, Port: {d[\"port\"]}')" 2>/dev/null
else
  echo "WARNING: Expected 1 process, found $COUNT"
fi
