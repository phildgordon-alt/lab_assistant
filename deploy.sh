#!/bin/bash
# deploy.sh — Pull and deploy a tagged release on the Mac Studio
# Usage: ./deploy.sh v2.0.0
# Run from: /Users/Shared/lab_assistant/
#
# Data files (SQLite DBs, adapter state) are backed up before checkout
# and restored after, so no data is lost during deploys.

set -euo pipefail

VERSION="${1:-}"
APP_DIR="/Users/Shared/lab_assistant"
LAB_SERVICE="com.paireyewear.labassistant.server"
GATEWAY_SERVICE="com.paireyewear.labassistant.gateway"
BACKUP_DIR="/Users/Shared/lab_assistant_backups"

# Data files to preserve across deploys
DATA_FILES=(
  "data/lab_assistant.db"
  "data/ews.db"
  "server/som-data.json"
  "server/network-data.json"
  "server/data/daily-picks.json"
  ".env"
  "gateway/.env"
)

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

# ── BACKUP DATA ──────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAP_DIR="$BACKUP_DIR/${CURRENT}_${TIMESTAMP}"
mkdir -p "$SNAP_DIR"

log "Backing up data to $SNAP_DIR..."
BACKED_UP=0
for f in "${DATA_FILES[@]}"; do
    if [ -f "$APP_DIR/$f" ]; then
        mkdir -p "$SNAP_DIR/$(dirname "$f")"
        cp "$APP_DIR/$f" "$SNAP_DIR/$f"
        BACKED_UP=$((BACKED_UP + 1))
    fi
done
# Also backup the entire data/ directory if it exists
if [ -d "$APP_DIR/data" ]; then
    cp -r "$APP_DIR/data" "$SNAP_DIR/data_full"
fi
log "Backed up $BACKED_UP files"

# Stop services
log "Stopping services..."
launchctl stop "$LAB_SERVICE" 2>/dev/null || true
launchctl stop "$GATEWAY_SERVICE" 2>/dev/null || true
sleep 2

# Checkout the tag
log "Checking out $VERSION..."
git checkout "$VERSION" --quiet

# ── RESTORE DATA ─────────────────────────────────────────────
log "Restoring data files..."
RESTORED=0
for f in "${DATA_FILES[@]}"; do
    if [ -f "$SNAP_DIR/$f" ]; then
        mkdir -p "$APP_DIR/$(dirname "$f")"
        cp "$SNAP_DIR/$f" "$APP_DIR/$f"
        RESTORED=$((RESTORED + 1))
    fi
done
log "Restored $RESTORED files"

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
if curl -sf http://localhost:3002/api/health >/dev/null 2>&1; then
    log "Lab Server (3002): ${GREEN}UP${NC}"
else
    warn "Lab Server (3002): not responding (may still be starting)"
fi

if curl -sf http://localhost:3001/gateway/health >/dev/null 2>&1; then
    log "Gateway (3001): ${GREEN}UP${NC}"
else
    warn "Gateway (3001): not responding (may still be starting)"
fi

# Cleanup old backups (keep last 10)
if [ -d "$BACKUP_DIR" ]; then
    BACKUP_COUNT=$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')
    if [ "$BACKUP_COUNT" -gt 10 ]; then
        REMOVE_COUNT=$((BACKUP_COUNT - 10))
        ls -1td "$BACKUP_DIR"/*/ | tail -n "$REMOVE_COUNT" | xargs rm -rf
        log "Cleaned up $REMOVE_COUNT old backups (keeping 10)"
    fi
fi

echo ""
log "Deployed $VERSION successfully"
log "Previous: $CURRENT → Now: $VERSION"
log "Backup: $SNAP_DIR"
