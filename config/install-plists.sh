#!/bin/bash
# Install launchd plist files for Lab Assistant
# Run from: /Users/Shared/lab_assistant/
# Usage: bash config/install-plists.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
LA=~/Library/LaunchAgents

echo "Stopping existing services..."
launchctl stop com.paireyewear.labassistant.server 2>/dev/null
launchctl stop com.paireyewear.labassistant.gateway 2>/dev/null
sleep 2
lsof -ti:3002 | xargs kill -9 2>/dev/null
lsof -ti:3001 | xargs kill -9 2>/dev/null
sleep 1

echo "Removing old plists..."
launchctl unload "$LA/com.paireyewear.labassistant.server.plist" 2>/dev/null
launchctl unload "$LA/com.paireyewear.labassistant.gateway.plist" 2>/dev/null
rm -f "$LA/com.paireyewear.labassistant.server.plist"
rm -f "$LA/com.paireyewear.labassistant.gateway.plist"

echo "Copying new plists..."
cp "$DIR/com.paireyewear.labassistant.server.plist" "$LA/"
cp "$DIR/com.paireyewear.labassistant.gateway.plist" "$LA/"

echo "Validating..."
plutil "$LA/com.paireyewear.labassistant.server.plist"
plutil "$LA/com.paireyewear.labassistant.gateway.plist"

echo "Loading services..."
launchctl load "$LA/com.paireyewear.labassistant.server.plist"
launchctl load "$LA/com.paireyewear.labassistant.gateway.plist"

sleep 3

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
