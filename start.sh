#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export NODE_OPTIONS="--openssl-legacy-provider"

echo "Starting Lab Server (port 3002)..."
node server/oven-timer-server.js &
LAB_PID=$!

echo "Starting Gateway (port 3001)..."
cd gateway && npx tsx index.ts &
GW_PID=$!
cd "$DIR"

echo "Starting Frontend (port 5173)..."
npx vite --host &
FE_PID=$!

echo ""
echo "Lab Server PID: $LAB_PID (port 3002)"
echo "Gateway PID:    $GW_PID (port 3001)"
echo "Frontend PID:   $FE_PID (port 5173)"
echo ""
echo "Open http://localhost:5173"
echo "Press Ctrl+C to stop all servers"
trap "kill $LAB_PID $GW_PID $FE_PID 2>/dev/null; exit" INT TERM
wait
