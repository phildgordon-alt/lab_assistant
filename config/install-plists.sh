#!/bin/bash
# Install launchd plist files for Lab Assistant
# Run from: /Users/Shared/lab_assistant/
# Usage: bash config/install-plists.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
LA=~/Library/LaunchAgents
SRV=com.paireyewear.labassistant.server.plist
GW=com.paireyewear.labassistant.gateway.plist
UID_NUM=$(id -u)

echo "Installing plist files..."

# Stop existing
launchctl bootout gui/$UID_NUM/$LA/$SRV 2>/dev/null
launchctl bootout gui/$UID_NUM/$LA/$GW 2>/dev/null
lsof -ti:3002 | xargs kill -9 2>/dev/null
lsof -ti:3001 | xargs kill -9 2>/dev/null
sleep 2

# Remove old
rm -f $LA/$SRV
rm -f $LA/$GW

# Copy new
cp $DIR/$SRV $LA/$SRV
cp $DIR/$GW $LA/$GW

# Validate
echo "Validating..."
plutil $LA/$SRV
plutil $LA/$GW

# Load
echo "Loading..."
launchctl bootstrap gui/$UID_NUM $LA/$SRV
launchctl bootstrap gui/$UID_NUM $LA/$GW

sleep 3

# Verify
echo ""
if curl -sf http://localhost:3002/health >/dev/null 2>&1; then
  echo "Server (3002): UP"
else
  echo "Server (3002): not responding yet"
fi

if curl -sf http://localhost:3001/gateway/health >/dev/null 2>&1; then
  echo "Gateway (3001): UP"
else
  echo "Gateway (3001): not responding yet"
fi

echo "Done."
