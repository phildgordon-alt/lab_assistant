#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Lab_Assistant Installer — Pair Eyewear Irvine Lens Lab
# One-shot setup for a fresh Mac
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
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo -e "\n${BLUE}${BOLD}── $1 ──${NC}"; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         Lab_Assistant Installer — Pair Eyewear          ║"
echo "║         Irvine Lens Lab MES                             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Detect script location vs install target ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${LAB_ASSISTANT_DIR:-$SCRIPT_DIR}"

# If running from a different location, allow specifying install dir
if [ "$1" = "--dir" ] && [ -n "$2" ]; then
  INSTALL_DIR="$2"
fi

echo "Install directory: $INSTALL_DIR"
echo ""

# ── 1. Xcode Command Line Tools ──────────────────────────────────
step "Xcode Command Line Tools (required for native modules)"
if xcode-select -p &>/dev/null; then
  log "Already installed"
else
  warn "Installing Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo "    Press Install in the dialog, then re-run this script when done."
  exit 1
fi

# ── 2. Homebrew ───────────────────────────────────────────────────
step "Homebrew"
if command -v brew &>/dev/null; then
  log "Already installed ($(brew --version | head -1))"
else
  warn "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add to PATH for Apple Silicon Macs
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  fi
  log "Homebrew installed"
fi

# ── 3. Node.js ────────────────────────────────────────────────────
step "Node.js"
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
  log "Already installed ($NODE_VER)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "Node.js $NODE_VER is too old. Installing latest LTS..."
    brew install node@22
    brew link --overwrite node@22
  fi
else
  warn "Installing Node.js via Homebrew..."
  brew install node@22
  brew link --overwrite node@22 2>/dev/null || true
  # Ensure node/npm are on PATH now
  export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  log "Node.js installed ($(node -v))"
fi

# Ensure npm is available regardless of install method
if ! command -v npm &>/dev/null; then
  export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  if ! command -v npm &>/dev/null; then
    err "npm still not found after Node install. Open a new terminal and re-run this script."
    exit 1
  fi
fi

# ── 4. Python 3 (required for better-sqlite3 compilation) ────────
step "Python 3 (native module build)"
if command -v python3 &>/dev/null; then
  log "Already installed ($(python3 --version))"
else
  warn "Installing Python 3..."
  brew install python3
  log "Python 3 installed"
fi

# ── 5. Git ────────────────────────────────────────────────────────
step "Git"
if command -v git &>/dev/null; then
  log "Already installed ($(git --version))"
else
  warn "Installing Git..."
  brew install git
  log "Git installed"
fi

# ── 6. Project files ──────────────────────────────────────────────
step "Project files"
if [ -f "$INSTALL_DIR/package.json" ]; then
  log "Project found at $INSTALL_DIR"
else
  err "No package.json found at $INSTALL_DIR"
  echo "    Either run this script from the project root,"
  echo "    or specify: ./install.sh --dir /path/to/lab_assistant"
  exit 1
fi

cd "$INSTALL_DIR"

# ── 7. Root npm dependencies ─────────────────────────────────────
step "Frontend & server dependencies (root)"
npm install
log "Root dependencies installed"

# ── 8. Gateway dependencies ───────────────────────────────────────
step "Gateway dependencies"
if [ -d "gateway" ] && [ -f "gateway/package.json" ]; then
  cd gateway
  npm install
  log "Gateway dependencies installed"
  cd ..
else
  warn "No gateway/ directory found — skipping"
fi

# ── 9. Environment files ─────────────────────────────────────────
step "Environment configuration"

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
  else
    cat > .env << 'ENVEOF'
# Lab Server (port 3002)
PORT=3002

# SOM (Schneider) MySQL
SOM_HOST=192.168.0.155
SOM_PORT=3306
SOM_USER=root
SOM_PASSWORD=
SOM_DATABASE=som_lms

# DVI File Sync
DVI_SYNC_HOST=192.168.0.27
DVI_SYNC_USER=
DVI_SYNC_PASSWORD=

# ItemPath (Kardex)
ITEMPATH_URL=https://paireyewear.itempath.com
ITEMPATH_TOKEN=

# Limble CMMS
LIMBLE_URL=https://api.limblecmms.com
LIMBLE_CLIENT_ID=
LIMBLE_CLIENT_SECRET=
ENVEOF
  fi
  warn "Created .env — fill in your credentials"
else
  log ".env already exists"
fi

if [ ! -f "gateway/.env" ]; then
  if [ -f "gateway/.env.example" ]; then
    cp gateway/.env.example gateway/.env
  else
    cat > gateway/.env << 'ENVEOF'
# Lab Assistant API (existing system)
LAB_ASSISTANT_API_URL=http://localhost:3002
LAB_ASSISTANT_API_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# Slack
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APP_TOKEN=

# DVI SOAP
DVI_SOAP_URL=https://dvirx.com:443/DVIRx/services/DVIRxSOAP
DVI_USERNAME=
DVI_PASSWORD=
DVI_APPLICATION=

# ItemPath (Kardex)
ITEMPATH_URL=https://paireyewear.itempath.com
ITEMPATH_TOKEN=

# Limble CMMS
LIMBLE_URL=https://api.limblecmms.com
LIMBLE_CLIENT_ID=
LIMBLE_CLIENT_SECRET=

# Auth
JWT_SECRET=change-this-to-a-random-string

# Server
PORT=3001
NODE_ENV=development
ENVEOF
  fi
  warn "Created gateway/.env — fill in your credentials"
else
  log "gateway/.env already exists"
fi

# ── 10. Data directories ─────────────────────────────────────────
step "Data directories"
mkdir -p data server/data
log "data/ and server/data/ ready"

# ── 11. Build frontend ───────────────────────────────────────────
step "Building frontend"
npm run build 2>/dev/null && log "Frontend built" || warn "Frontend build skipped (dev mode works without it)"

# ── 12. Create launch scripts ────────────────────────────────────
step "Creating launch scripts"

cat > start.sh << 'STARTEOF'
#!/bin/bash
# Start both Lab_Assistant servers
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Node v25+ needs legacy OpenSSL for SMB2/DVI
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
echo ""
echo "Frontend dev:   npm run dev  (port 5173)"
echo ""
echo "Press Ctrl+C to stop both servers"

trap "kill $LAB_PID $GW_PID 2>/dev/null; exit" INT TERM
wait
STARTEOF
chmod +x start.sh

cat > stop.sh << 'STOPEOF'
#!/bin/bash
# Stop Lab_Assistant servers
pkill -f "node.*oven-timer-server" 2>/dev/null && echo "Lab Server stopped" || echo "Lab Server not running"
pkill -f "tsx.*index.ts" 2>/dev/null && echo "Gateway stopped" || echo "Gateway not running"
STOPEOF
chmod +x stop.sh

log "Created start.sh and stop.sh"

# ── 13. Create launchd plists for auto-start + crash recovery ─────
step "Auto-start configuration (all 3 services)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_LAB="$PLIST_DIR/com.paireyewear.labassistant.server.plist"
PLIST_GW="$PLIST_DIR/com.paireyewear.labassistant.gateway.plist"
PLIST_FE="$PLIST_DIR/com.paireyewear.labassistant.frontend.plist"

mkdir -p "$PLIST_DIR"

# Find absolute paths to node/npx (launchd doesn't inherit shell PATH)
NODE_PATH=$(which node || echo "/opt/homebrew/bin/node")
NPX_PATH=$(which npx || echo "/opt/homebrew/bin/npx")

# -- Lab Server (port 3002) --
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
    <string>/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin</string>
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

# -- Gateway (port 3001) --
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
    <string>/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin</string>
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

# -- Frontend (port 5173) --
cat > "$PLIST_FE" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paireyewear.labassistant.frontend</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPX_PATH</string>
    <string>vite</string>
    <string>--host</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/server/data/frontend.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/server/data/frontend-error.log</string>
</dict>
</plist>
PLISTEOF

# Unload any old versions, then load all three
launchctl unload "$PLIST_LAB" 2>/dev/null || true
launchctl unload "$PLIST_GW" 2>/dev/null || true
launchctl unload "$PLIST_FE" 2>/dev/null || true
launchctl load "$PLIST_LAB"
launchctl load "$PLIST_GW"
launchctl load "$PLIST_FE"
log "Auto-start enabled for all 3 services"
echo "    Lab Server  → port 3002 (auto-restart on crash)"
echo "    Gateway     → port 3001 (auto-restart on crash)"
echo "    Frontend    → port 5173 (auto-restart on crash)"
echo "    All start automatically on login/reboot"

# ── 14. Verify ────────────────────────────────────────────────────
step "Verification"

ISSUES=0

command -v node &>/dev/null && log "node $(node -v)" || { err "node not found"; ISSUES=$((ISSUES+1)); }
command -v npm &>/dev/null && log "npm $(npm -v)" || { err "npm not found"; ISSUES=$((ISSUES+1)); }
[ -d "node_modules" ] && log "Root node_modules installed ($(ls node_modules | wc -l | tr -d ' ') packages)" || { err "Root node_modules missing"; ISSUES=$((ISSUES+1)); }
[ -d "gateway/node_modules" ] && log "Gateway node_modules installed" || { warn "Gateway node_modules missing"; }
[ -f ".env" ] && log ".env exists" || { warn ".env missing — create from template"; }
[ -f "node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] && log "better-sqlite3 native module compiled" || { warn "better-sqlite3 may need rebuild: npm rebuild better-sqlite3"; }

echo ""
if [ $ISSUES -eq 0 ]; then
  echo -e "${GREEN}${BOLD}Installation complete!${NC}"
else
  echo -e "${YELLOW}${BOLD}Installation complete with $ISSUES warning(s)${NC}"
fi

echo ""
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "localhost")
echo -e "${BOLD}All 3 services are running and will auto-start on reboot:${NC}"
echo "  Lab Server  → http://$LOCAL_IP:3002"
echo "  Gateway     → http://$LOCAL_IP:3001"
echo "  Frontend    → http://$LOCAL_IP:5173"
echo ""
echo -e "${BOLD}Access from any device on the network:${NC}"
echo "  http://$LOCAL_IP:5173              — Full desktop"
echo "  http://$LOCAL_IP:5173/?mode=tablet — Tablet (touch-optimized)"
echo "  http://$LOCAL_IP:5173/?mode=corporate — Corporate (read-only)"
echo ""
echo -e "${BOLD}Manual controls:${NC}"
echo "  ./start.sh   — Start all services"
echo "  ./stop.sh    — Stop all services"
echo ""
echo -e "${BOLD}Standalone apps (open directly in browser):${NC}"
echo "  standalone/OvenTimer.html"
echo "  standalone/CoatingTimer.html"
echo "  standalone/AssemblyDashboard.html"
echo ""
