#!/bin/bash
# deploy.sh — Pull and deploy a tagged release on the Mac Studio
# Usage: ./deploy.sh v2.0.0
# Run from: /Users/Shared/lab_assistant/

set -euo pipefail

VERSION="${1:-}"
APP_DIR="/Users/Shared/lab_assistant"
LAB_SERVICE="com.paireyewear.labassistant.server"
GATEWAY_SERVICE="com.paireyewear.labassistant.gateway"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
err()  { echo -e "${RED}[deploy]${NC} $1" >&2; }

if [ -z "$VERSION" ]; then
    echo "Usage: ./deploy.sh <version>"
    echo ""
    echo "Available versions:"
    git fetch --tags --quiet
    git tag -l 'v*' --sort=-v:refname | head -10
    exit 1
fi

cd "$APP_DIR"

# Preflight
log "Deploying $VERSION to $APP_DIR"
CURRENT=$(git describe --tags --always 2>/dev/null || echo "unknown")
log "Current version: $CURRENT"

# Fetch latest
log "Fetching from origin..."
git fetch origin --tags

# Verify tag exists
if ! git rev-parse "$VERSION" >/dev/null 2>&1; then
    err "Tag $VERSION not found. Available tags:"
    git tag -l 'v*' --sort=-v:refname | head -10
    exit 1
fi

# Stop services
log "Stopping services..."
launchctl stop "$LAB_SERVICE" 2>/dev/null || true
launchctl stop "$GATEWAY_SERVICE" 2>/dev/null || true
sleep 2

# Checkout the tag
log "Checking out $VERSION..."
git checkout "$VERSION" --quiet

# Install deps if package.json changed
if ! git diff --quiet "$CURRENT" "$VERSION" -- package.json 2>/dev/null; then
    log "package.json changed — running npm install..."
    npm install --production --quiet
fi

if ! git diff --quiet "$CURRENT" "$VERSION" -- gateway/package.json 2>/dev/null; then
    log "gateway/package.json changed — running npm install in gateway..."
    cd gateway && npm install --production --quiet && cd ..
fi

# Restart services
log "Starting services..."
launchctl start "$LAB_SERVICE"
sleep 2
launchctl start "$GATEWAY_SERVICE"
sleep 2

# Verify
LAB_OK=false
GW_OK=false

if curl -sf http://localhost:3002/api/health >/dev/null 2>&1; then
    LAB_OK=true
    log "Lab Server (3002): ${GREEN}UP${NC}"
else
    warn "Lab Server (3002): not responding (may still be starting)"
fi

if curl -sf http://localhost:3001/gateway/health >/dev/null 2>&1; then
    GW_OK=true
    log "Gateway (3001): ${GREEN}UP${NC}"
else
    warn "Gateway (3001): not responding (may still be starting)"
fi

echo ""
log "Deployed $VERSION successfully"
log "Previous: $CURRENT → Now: $VERSION"
