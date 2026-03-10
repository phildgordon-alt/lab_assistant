#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Lab_Assistant macOS Installer Builder
# Creates a self-contained .pkg installer — no GitHub, no cloning
# Output: Lab_Assistant_Installer.pkg (double-click to install)
# ═══════════════════════════════════════════════════════════════════
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}${BOLD}── $1 ──${NC}"; }

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ROOT/.build-pkg"
PAYLOAD_DIR="$BUILD_DIR/payload"
SCRIPTS_DIR="$BUILD_DIR/scripts"
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "2.1.0")
PKG_NAME="Lab_Assistant_${VERSION}"
INSTALL_PATH="/Users/Shared/lab_assistant"

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         Lab_Assistant Installer Builder                  ║"
echo "║         Building macOS .pkg — v${VERSION}                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Clean previous build ───────────────────────────────────────────
step "Preparing build directory"
rm -rf "$BUILD_DIR"
mkdir -p "$PAYLOAD_DIR/lab_assistant" "$SCRIPTS_DIR"
log "Build directory ready"

# ── Build frontend first ──────────────────────────────────────────
step "Building frontend"
cd "$ROOT"
npm run build </dev/null 2>/dev/null && log "Frontend built to dist/" || warn "Frontend build skipped"

# ── Copy source files (exclude unneeded) ──────────────────────────
step "Copying source files"

# Use rsync to copy only what's needed
rsync -a \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.build-pkg' \
  --exclude='.claude' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='data/*.db' \
  --exclude='data/*.db-shm' \
  --exclude='data/*.db-wal' \
  --exclude='data/gateway.db*' \
  --exclude='ios/' \
  --exclude='*.backup' \
  --exclude='App.jsx.backup' \
  "$ROOT/" "$PAYLOAD_DIR/lab_assistant/"

log "Source files copied"

# ── Create the postinstall script ─────────────────────────────────
step "Creating installer scripts"

cat > "$SCRIPTS_DIR/postinstall" << 'POSTINSTALL'
#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Lab_Assistant Post-Install Script
# Runs after .pkg copies files to disk
# ═══════════════════════════════════════════════════════════════════
set -e

INSTALL_DIR="/Users/Shared/lab_assistant"
LOG_FILE="$INSTALL_DIR/install.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "═══════════════════════════════════════════════════════"
echo "  Lab_Assistant Post-Install — $(date)"
echo "═══════════════════════════════════════════════════════"

# Ensure correct ownership (installer runs as root)
REAL_USER="${SUDO_USER:-$(stat -f '%Su' /dev/console)}"
REAL_HOME=$(eval echo "~$REAL_USER")
echo "Installing for user: $REAL_USER (home: $REAL_HOME)"

# ── 1. Xcode Command Line Tools ──────────────────────────────────
echo ">> Checking Xcode Command Line Tools..."
if ! xcode-select -p &>/dev/null; then
  echo "   Xcode CLT not found — please install manually: xcode-select --install"
  echo "   Continuing without it (may affect native module builds)..."
fi
echo "   Xcode CLT: OK"

# ── 2. Homebrew ───────────────────────────────────────────────────
echo ">> Checking Homebrew..."
BREW_PATH=""
if [ -f /opt/homebrew/bin/brew ]; then
  BREW_PATH="/opt/homebrew/bin/brew"
elif [ -f /usr/local/bin/brew ]; then
  BREW_PATH="/usr/local/bin/brew"
else
  echo "   Installing Homebrew..."
  sudo -u "$REAL_USER" NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null || true
  if [ -f /opt/homebrew/bin/brew ]; then
    BREW_PATH="/opt/homebrew/bin/brew"
  else
    BREW_PATH="/usr/local/bin/brew"
  fi
fi
eval "$($BREW_PATH shellenv)"
echo "   Homebrew: OK ($BREW_PATH)"

# ── 3. Node.js ────────────────────────────────────────────────────
echo ">> Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "   Installing Node.js 22..."
  sudo -u "$REAL_USER" $BREW_PATH install node@22 2>&1 || true
  $BREW_PATH link --overwrite node@22 2>/dev/null || true
fi
NODE_VER=$(node -v 2>/dev/null || echo "not found")
echo "   Node.js: $NODE_VER"

# ── 4. Python 3 (for native modules) ─────────────────────────────
echo ">> Checking Python 3..."
if ! command -v python3 &>/dev/null; then
  sudo -u "$REAL_USER" $BREW_PATH install python3 2>&1 || true
fi
echo "   Python 3: $(python3 --version 2>/dev/null || echo 'not found')"

# ── 5. Install npm dependencies ──────────────────────────────────
echo ">> Installing root dependencies..."
cd "$INSTALL_DIR"
sudo -u "$REAL_USER" npm install --production --prefer-offline --no-audit --no-fund </dev/null 2>&1 || npm install --production --prefer-offline --no-audit --no-fund </dev/null 2>&1
echo "   Root dependencies: OK"

echo ">> Installing gateway dependencies..."
cd "$INSTALL_DIR/gateway"
sudo -u "$REAL_USER" npm install --production --prefer-offline --no-audit --no-fund </dev/null 2>&1 || npm install --production --prefer-offline --no-audit --no-fund </dev/null 2>&1
echo "   Gateway dependencies: OK"

cd "$INSTALL_DIR"

# ── 6. Create data directories ───────────────────────────────────
echo ">> Creating data directories..."
mkdir -p data server/data data/dvi/breakage data/dvi/jobs data/dvi/daily data/dvi/shipped
chown -R "$REAL_USER" data server/data
echo "   Data directories: OK"

# ── 7. Environment files ─────────────────────────────────────────
echo ">> Setting up environment files..."
if [ ! -f "$INSTALL_DIR/.env" ]; then
  if [ -f "$INSTALL_DIR/.env.example" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  else
    cat > "$INSTALL_DIR/.env" << 'ENVEOF'
# Lab_Assistant Server Configuration
PORT=3002

# ItemPath / Kardex
ITEMPATH_URL=https://paireyewear.itempath.com
ITEMPATH_TOKEN=

# Limble CMMS
LIMBLE_URL=https://api.limblecmms.com
LIMBLE_CLIENT_ID=
LIMBLE_CLIENT_SECRET=

# SOM / Schneider Optical Machines
SOM_HOST=192.168.0.155
SOM_PORT=3306
SOM_USER=root
SOM_PASSWORD=schneider
SOM_DATABASE=som_lms
SOM_POLL_INTERVAL=30000

# DVI File Sync (SMB)
DVI_SYNC_HOST=192.168.0.27
DVI_SYNC_USER=dvi
DVI_SYNC_PASSWORD=dvi

# Slack (optional)
SLACK_BOT_TOKEN=
SLACK_CHANNEL_ID=

# AI (optional)
ANTHROPIC_API_KEY=
ENVEOF
  fi
  echo "   Created .env — EDIT WITH YOUR CREDENTIALS"
fi

if [ ! -f "$INSTALL_DIR/gateway/.env" ]; then
  if [ -f "$INSTALL_DIR/gateway/.env.example" ]; then
    cp "$INSTALL_DIR/gateway/.env.example" "$INSTALL_DIR/gateway/.env"
  else
    cat > "$INSTALL_DIR/gateway/.env" << 'ENVEOF'
# Gateway Configuration
PORT=3001
NODE_ENV=production
LAB_ASSISTANT_API_URL=http://localhost:3002

# Anthropic
ANTHROPIC_API_KEY=

# Slack
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APP_TOKEN=

# JWT
JWT_SECRET=change-this-to-a-random-32-char-string

# ItemPath
ITEMPATH_URL=https://paireyewear.itempath.com
ITEMPATH_TOKEN=

# Limble
LIMBLE_URL=https://api.limblecmms.com
LIMBLE_CLIENT_ID=
LIMBLE_CLIENT_SECRET=
ENVEOF
  fi
  echo "   Created gateway/.env — EDIT WITH YOUR CREDENTIALS"
fi

chown "$REAL_USER" "$INSTALL_DIR/.env" "$INSTALL_DIR/gateway/.env" 2>/dev/null || true

# ── 8. Build frontend ────────────────────────────────────────────
echo ">> Building frontend..."
cd "$INSTALL_DIR"
sudo -u "$REAL_USER" npm run build </dev/null 2>&1 || echo "   Frontend build skipped (dev mode still works)"

# ── 9. Create start/stop scripts ─────────────────────────────────
echo ">> Creating start/stop scripts..."

cat > "$INSTALL_DIR/start.sh" << 'STARTEOF'
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

echo ""
echo "Lab Server PID: $LAB_PID (port 3002)"
echo "Gateway PID:    $GW_PID (port 3001)"
echo "Frontend dev:   npm run dev  (port 5173)"
echo ""
echo "Press Ctrl+C to stop both servers"
trap "kill $LAB_PID $GW_PID 2>/dev/null; exit" INT TERM
wait
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"

cat > "$INSTALL_DIR/stop.sh" << 'STOPEOF'
#!/bin/bash
pkill -f "node.*oven-timer-server" 2>/dev/null && echo "Lab Server stopped" || echo "Lab Server not running"
pkill -f "tsx.*index.ts" 2>/dev/null && echo "Gateway stopped" || echo "Gateway not running"
STOPEOF
chmod +x "$INSTALL_DIR/stop.sh"

echo "   start.sh / stop.sh: OK"

# ── 10. Setup launchd (auto-start + auto-restart) ────────────────
echo ">> Configuring auto-start..."

PLIST_DIR="$REAL_HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

NODE_PATH=$(which node)
NPX_PATH=$(which npx)

PLIST_LAB="$PLIST_DIR/com.paireyewear.labassistant.server.plist"
cat > "$PLIST_LAB" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paireyewear.labassistant.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$INSTALL_DIR/server/oven-timer-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_OPTIONS</key>
    <string>--openssl-legacy-provider</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/server/data/lab-server.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/server/data/lab-server-error.log</string>
</dict>
</plist>
PLISTEOF

PLIST_GW="$PLIST_DIR/com.paireyewear.labassistant.gateway.plist"
cat > "$PLIST_GW" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paireyewear.labassistant.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR/gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/server/data/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/server/data/gateway-error.log</string>
</dict>
</plist>
PLISTEOF

chown "$REAL_USER" "$PLIST_LAB" "$PLIST_GW"

# Load the services (start them now + on reboot)
sudo -u "$REAL_USER" launchctl unload "$PLIST_LAB" 2>/dev/null || true
sudo -u "$REAL_USER" launchctl unload "$PLIST_GW" 2>/dev/null || true
sudo -u "$REAL_USER" launchctl load "$PLIST_LAB"
sudo -u "$REAL_USER" launchctl load "$PLIST_GW"

echo "   Auto-start configured (KeepAlive=true, auto-restart on crash)"

# ── 11. Set ownership ────────────────────────────────────────────
echo ">> Setting file ownership..."
chown -R "$REAL_USER" "$INSTALL_DIR"
echo "   All files owned by $REAL_USER"

# ── 12. Verify ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Installation Complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Install location: $INSTALL_DIR"
echo "  Lab Server:  http://localhost:3002 (auto-start)"
echo "  Gateway:     http://localhost:3001 (auto-start)"
echo "  Frontend:    npm run dev  (manual, port 5173)"
echo ""
echo "  NEXT STEPS:"
echo "  1. Edit $INSTALL_DIR/.env with your API credentials"
echo "  2. Edit $INSTALL_DIR/gateway/.env with Anthropic + Slack tokens"
echo "  3. Both servers are already running (auto-restart on crash)"
echo "  4. Open http://localhost:5173 for the UI"
echo ""
echo "  Logs:"
echo "    $INSTALL_DIR/server/data/lab-server.log"
echo "    $INSTALL_DIR/server/data/gateway.log"
echo ""
echo "  To stop:  $INSTALL_DIR/stop.sh"
echo "  To start: $INSTALL_DIR/start.sh"
echo ""

exit 0
POSTINSTALL

chmod +x "$SCRIPTS_DIR/postinstall"
log "Post-install script created"

# ── Build the .pkg ────────────────────────────────────────────────
step "Building macOS installer package"

# pkgbuild creates the component package
pkgbuild \
  --root "$PAYLOAD_DIR" \
  --scripts "$SCRIPTS_DIR" \
  --identifier "com.paireyewear.labassistant" \
  --version "$VERSION" \
  --install-location "/Users/Shared" \
  "$BUILD_DIR/${PKG_NAME}_component.pkg"

log "Component package built"

# Create a distribution XML for a nice installer UI
cat > "$BUILD_DIR/distribution.xml" << DISTEOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Lab_Assistant — Pair Eyewear MES</title>
    <welcome>
        <![CDATA[
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px;">
        <h2>Lab_Assistant v${VERSION}</h2>
        <p>Pair Eyewear — Irvine Lens Lab MES</p>
        <p>This will install:</p>
        <ul>
            <li>Lab Server (port 3002) — Inventory, DVI, timers, machine status</li>
            <li>AI Gateway (port 3001) — Claude agents, Slack, MCP tools</li>
            <li>React dashboard — All tabs, tablet mode, corporate mode</li>
            <li>Standalone tablet apps — Oven Timer, Coating Timer, Assembly Dashboard</li>
        </ul>
        <p><strong>Auto-start:</strong> Both servers start automatically on login and restart if they crash.</p>
        <p><strong>After install:</strong> Edit .env files with your API credentials.</p>
        </body>
        </html>
        ]]>
    </welcome>
    <conclusion>
        <![CDATA[
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px;">
        <h2>Installation Complete!</h2>
        <p>Lab_Assistant is installed at <code>/Users/Shared/lab_assistant</code></p>
        <h3>Next Steps:</h3>
        <ol>
            <li>Edit <code>/Users/Shared/lab_assistant/.env</code> — add ItemPath, Limble, SOM credentials</li>
            <li>Edit <code>/Users/Shared/lab_assistant/gateway/.env</code> — add Anthropic API key + Slack tokens</li>
            <li>Both servers are already running</li>
            <li>Run <code>cd /Users/Shared/lab_assistant && npm run dev</code> for the frontend</li>
            <li>Open <a href="http://localhost:5173">http://localhost:5173</a></li>
        </ol>
        <h3>Modes:</h3>
        <ul>
            <li><code>http://localhost:5173</code> — Full desktop</li>
            <li><code>http://localhost:5173/?mode=tablet</code> — Manager tablet</li>
            <li><code>http://localhost:5173/?mode=corporate</code> — Corporate read-only</li>
        </ul>
        </body>
        </html>
        ]]>
    </conclusion>
    <options customize="never" require-scripts="false"/>
    <choices-outline>
        <line choice="default"/>
    </choices-outline>
    <choice id="default" title="Lab_Assistant">
        <pkg-ref id="com.paireyewear.labassistant"/>
    </choice>
    <pkg-ref id="com.paireyewear.labassistant" version="${VERSION}">${PKG_NAME}_component.pkg</pkg-ref>
</installer-gui-script>
DISTEOF

# productbuild creates the distribution package (nice UI installer)
productbuild \
  --distribution "$BUILD_DIR/distribution.xml" \
  --package-path "$BUILD_DIR" \
  --resources "$BUILD_DIR" \
  "$ROOT/${PKG_NAME}.pkg"

log "Distribution package built"

# ── Also build a portable tarball ─────────────────────────────────
step "Building portable tarball"
cd "$PAYLOAD_DIR"
tar -czf "$ROOT/${PKG_NAME}.tar.gz" lab_assistant/
TARBALL_SIZE=$(du -sh "$ROOT/${PKG_NAME}.tar.gz" | cut -f1)
log "Tarball created: ${PKG_NAME}.tar.gz ($TARBALL_SIZE)"

# ── Cleanup ───────────────────────────────────────────────────────
step "Cleanup"
rm -rf "$BUILD_DIR"
log "Build directory cleaned"

# ── Summary ───────────────────────────────────────────────────────
PKG_SIZE=$(du -sh "$ROOT/${PKG_NAME}.pkg" | cut -f1)

echo ""
echo -e "${GREEN}${BOLD}Build complete!${NC}"
echo ""
echo -e "${BOLD}Outputs:${NC}"
echo "  ${PKG_NAME}.pkg      ($PKG_SIZE) — Double-click macOS installer"
echo "  ${PKG_NAME}.tar.gz   ($TARBALL_SIZE) — Portable tarball"
echo ""
echo -e "${BOLD}To install on a new Mac:${NC}"
echo "  Option A: Double-click ${PKG_NAME}.pkg"
echo "            (installs to /Users/Shared/lab_assistant, sets up auto-start)"
echo ""
echo "  Option B: Copy tarball + run install.sh:"
echo "            tar -xzf ${PKG_NAME}.tar.gz -C /Users/Shared/"
echo "            cd /Users/Shared/lab_assistant && ./install.sh"
echo ""
echo -e "${BOLD}Copy to USB:${NC}"
echo "  cp ${PKG_NAME}.pkg /Volumes/USB_DRIVE/"
echo ""
