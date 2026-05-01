#!/bin/bash
# Setup Power Pick env vars on prod, then kickstart the Lab Server.
# Idempotent — safe to run twice. Skips append if POWERPICK_HOST is already
# in the .env file. Run from anywhere on prod (Mac Studio):
#
#   bash /Users/Shared/lab_assistant/scripts/setup-powerpick-env.sh
#
# Or from the repo root:
#
#   bash scripts/setup-powerpick-env.sh

set -e

ENV_FILE="/Users/Shared/lab_assistant/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

if grep -q '^POWERPICK_HOST=' "$ENV_FILE"; then
  echo "POWERPICK_* already present in $ENV_FILE — skipping append"
else
  echo "Appending POWERPICK_* + ITEMPATH_PICKSYNC_DISABLED to $ENV_FILE"
  cat >> "$ENV_FILE" <<'ENVBLOCK'

# Power Pick (Kardex direct SQL Server) — added 2026-05-01
POWERPICK_HOST=68.15.89.205
POWERPICK_PORT=1433
POWERPICK_DATABASE=PPG_IMPORTS
POWERPICK_USER=Administrator
POWERPICK_PASSWORD=Pair1935
POWERPICK_POLL_INTERVAL=30000
POWERPICK_ENCRYPT=false
ITEMPATH_PICKSYNC_DISABLED=true
ENVBLOCK
fi

echo ""
echo "── .env now contains: ──"
grep -E '^POWERPICK_|^ITEMPATH_PICKSYNC' "$ENV_FILE"

echo ""
echo "── Kickstarting Lab Server ──"
launchctl kickstart -k "gui/$(id -u)/com.paireyewear.labassistant.server"

echo ""
echo "── Waiting 8s for server to come up ──"
sleep 8

echo ""
echo "── Power Pick status ──"
curl -s http://localhost:3002/api/powerpick/status
echo ""
echo ""
echo "If isLive=true, configReady=true, host=68.15.89.205 → ready for backfill:"
echo "  curl -s -X POST 'http://localhost:3002/api/powerpick/backfill?days=7'"
