#!/bin/bash
# Fix Power Pick credentials in /Users/Shared/lab_assistant/.env
# The first run of setup-powerpick-env.sh wrote the wrong user (Administrator,
# which is Windows-only auth and won't work from the Mac Studio over SQL auth).
# This script swaps to the SQL login that was actually created on the box:
#   lab_assistant_ro / YourStrongPassword!
#
# Idempotent — re-running just confirms the values are right.

set -e

ENV_FILE="/Users/Shared/lab_assistant/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

NEW_USER="lab_assistant_ro"
NEW_PASS='YourStrongPassword!'
NEW_DB="PowerPick"

# Swap POWERPICK_USER, POWERPICK_PASSWORD, and POWERPICK_DATABASE in place.
# The first setup-powerpick-env.sh seeded all three wrong. Verified working
# combo from prior session transcript: lab_assistant_ro / YourStrongPassword! / PowerPick
# macOS sed needs -i '' (empty backup suffix). | as delimiter to avoid escaping !
sed -i '' "s|^POWERPICK_USER=.*|POWERPICK_USER=${NEW_USER}|" "$ENV_FILE"
sed -i '' "s|^POWERPICK_PASSWORD=.*|POWERPICK_PASSWORD=${NEW_PASS}|" "$ENV_FILE"
sed -i '' "s|^POWERPICK_DATABASE=.*|POWERPICK_DATABASE=${NEW_DB}|" "$ENV_FILE"

echo "── .env now contains: ──"
grep -E '^POWERPICK_(USER|PASSWORD)=' "$ENV_FILE"

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
echo "If isLive=true, configReady=true, no connectionError → ready for backfill:"
echo "  curl -s -X POST 'http://localhost:3002/api/powerpick/backfill?days=7'"
