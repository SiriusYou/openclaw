#!/usr/bin/env bash
# ============================================================================
# MarketClaw Kit — One-Click Bootstrap
# ============================================================================
#
# Usage:
#   chmod +x setup.sh && ./setup.sh
#
# Prerequisites:
#   - Node.js 22+ (for OpenClaw CLI)
#   - openssl (for token generation)
#
# This script:
#   1. Checks prerequisites (Node 22+, openssl)
#   2. Installs OpenClaw CLI (if not present)
#   3. Generates secrets (.env)
#   4. Collects API keys and writes auth profiles
#   5. Creates workspace directories & seed files
#   6. Copies config templates (resolves __WORKSPACE_ROOT__)
#   7. Installs extensions
#   8. Installs and starts gateway daemon
#   9. Runs health check
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "\n${GREEN}━━━ Step $1: $2 ━━━${NC}"; }

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$SCRIPT_DIR"
CONFIG_DIR="$HOME/.openclaw"
WORKSPACES_DIR="$CONFIG_DIR/workspaces"
ENV_FILE="$KIT_DIR/.env"

# ============================================================================
# Step 1: Check Prerequisites
# ============================================================================
step 1 "Checking prerequisites"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 found: $(command -v "$1")"
    return 0
  else
    err "$1 not found"
    return 1
  fi
}

MISSING=0

check_cmd node     || MISSING=1
check_cmd openssl  || MISSING=1

# Check Node.js version >= 22
if command -v node &>/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    ok "Node.js version: $(node -v) (>= 22 required)"
  else
    err "Node.js version $(node -v) is too old. Need 22+."
    MISSING=1
  fi
fi

if [ "$MISSING" -eq 1 ]; then
  err "Missing prerequisites. Install them and re-run."
  exit 1
fi

ok "All prerequisites satisfied"

# ============================================================================
# Step 2: Install OpenClaw CLI
# ============================================================================
step 2 "Installing OpenClaw CLI"

if command -v openclaw &>/dev/null; then
  CLI_VERSION="$(openclaw --version 2>/dev/null || echo "unknown")"
  ok "OpenClaw CLI already installed: $CLI_VERSION"
else
  info "Installing OpenClaw CLI globally..."
  npm i -g openclaw@latest
  if command -v openclaw &>/dev/null; then
    ok "OpenClaw CLI installed: $(openclaw --version 2>/dev/null)"
  else
    err "Failed to install OpenClaw CLI"
    err "Try manually: npm i -g openclaw@latest"
    exit 1
  fi
fi

# ============================================================================
# Step 3: Generate Secrets & .env File
# ============================================================================
step 3 "Setting up environment variables"

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists at $ENV_FILE"
  read -rp "Overwrite? [y/N] " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    info "Keeping existing .env"
  else
    REGEN_ENV=1
  fi
else
  REGEN_ENV=1
fi

if [ "${REGEN_ENV:-0}" = "1" ]; then
  GATEWAY_TOKEN="$(openssl rand -hex 32)"

  cat > "$ENV_FILE" <<EOF
# ============================================================================
# MarketClaw Kit — Environment Variables
# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# ============================================================================

# --- Gateway ---
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
OPENCLAW_GATEWAY_BIND=loopback
OPENCLAW_GATEWAY_PORT=18789

# --- Paths ---
OPENCLAW_CONFIG_DIR=${CONFIG_DIR}
OPENCLAW_WORKSPACE_DIR=${WORKSPACES_DIR}

# --- Diagnostics ---
OPENCLAW_DIAGNOSTICS=1

# --- API Keys (for reference only — actual keys stored in auth-profiles.json) ---
# GOOGLE_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
# OPENAI_API_KEY=sk-...
EOF

  ok "Generated .env with gateway token: ${GATEWAY_TOKEN:0:8}..."
fi

# ============================================================================
# Step 4: Collect API Keys & Write Auth Profiles
# ============================================================================
step 4 "Configuring API keys"

AUTH_DIR="$CONFIG_DIR/agents/main/agent"
AUTH_FILE="$AUTH_DIR/auth-profiles.json"

if [ -f "$AUTH_FILE" ]; then
  warn "Auth profiles already exist at $AUTH_FILE"
  read -rp "Add/update API keys? [y/N] " UPDATE_AUTH
  if [[ ! "$UPDATE_AUTH" =~ ^[Yy]$ ]]; then
    info "Keeping existing auth profiles"
    SKIP_AUTH=1
  fi
fi

if [ "${SKIP_AUTH:-0}" != "1" ]; then
  echo ""
  info "The kit requires at least one chain-compatible API key:"
  info "  - Google API key (for google/gemini-3-pro-preview) — primary model"
  info "  - OpenRouter API key (for openrouter/auto) — fallback model"
  info "At least one of these is REQUIRED. Both recommended for failover."
  echo ""
  info "Get your keys:"
  info "  Google:     https://aistudio.google.com/apikey"
  info "  OpenRouter: https://openrouter.ai/keys"
  info "  OpenAI:     https://platform.openai.com/api-keys (optional)"
  echo ""

  read -rp "Google API key (press Enter to skip): " GOOGLE_KEY
  read -rp "OpenRouter API key (press Enter to skip): " OPENROUTER_KEY
  read -rp "OpenAI API key [optional] (press Enter to skip): " OPENAI_KEY

  # Validate at least one chain-compatible key
  if [[ -z "$GOOGLE_KEY" ]] && [[ -z "$OPENROUTER_KEY" ]]; then
    err "At least one chain-compatible key (Google or OpenRouter) is required."
    err "The kit's model chain (google/gemini-3-pro-preview → openrouter/auto)"
    err "cannot function without matching authentication."
    exit 1
  fi

  # Write auth profiles using Node script (merge semantics)
  GOOGLE_KEY="$GOOGLE_KEY" OPENROUTER_KEY="$OPENROUTER_KEY" OPENAI_KEY="$OPENAI_KEY" AUTH_DIR="$AUTH_DIR" node -e "
    const fs = require('fs');
    const dir = process.env.AUTH_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const path = dir + '/auth-profiles.json';
    const store = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
    store.profiles = store.profiles || {};
    const norm = (s) => s.trim().replace(/[^\x20-\x7E]/g, '');
    if (process.env.GOOGLE_KEY) store.profiles['google:default'] = { type: 'api_key', provider: 'google', key: norm(process.env.GOOGLE_KEY) };
    if (process.env.OPENROUTER_KEY) store.profiles['openrouter:default'] = { type: 'api_key', provider: 'openrouter', key: norm(process.env.OPENROUTER_KEY) };
    if (process.env.OPENAI_KEY) store.profiles['openai:default'] = { type: 'api_key', provider: 'openai', key: norm(process.env.OPENAI_KEY) };
    fs.writeFileSync(path, JSON.stringify(store, null, 2));
  "

  ok "Auth profiles written to $AUTH_FILE"
fi

# ============================================================================
# Step 5: Create Workspace Directories
# ============================================================================
step 5 "Creating workspace directories"

# Marketing Orchestrator workspace (only — no content/analytics subagent workspaces)
mkdir -p "$WORKSPACES_DIR/marketing/skills/core-marketing"
mkdir -p "$WORKSPACES_DIR/marketing/memory"
mkdir -p "$WORKSPACES_DIR/marketing/performance"
mkdir -p "$WORKSPACES_DIR/marketing/strategies"
mkdir -p "$WORKSPACES_DIR/marketing/status"

ok "Workspace directories created"

# ============================================================================
# Step 6: Copy Config & Seed Files
# ============================================================================
step 6 "Copying configuration and seed files"

# Create config directory
mkdir -p "$CONFIG_DIR"

# Copy openclaw.json and resolve workspace path placeholders
if [ ! -f "$CONFIG_DIR/openclaw.json" ]; then
  sed "s|__WORKSPACE_ROOT__|${WORKSPACES_DIR}|g" \
    "$KIT_DIR/openclaw.json" > "$CONFIG_DIR/openclaw.json"
  ok "Copied openclaw.json to $CONFIG_DIR/ (workspace paths: $WORKSPACES_DIR)"
else
  warn "openclaw.json already exists in $CONFIG_DIR/, skipping"
  if grep -q '__WORKSPACE_ROOT__' "$CONFIG_DIR/openclaw.json" 2>/dev/null; then
    info "Resolving __WORKSPACE_ROOT__ placeholders in existing config..."
    sed -i.bak "s|__WORKSPACE_ROOT__|${WORKSPACES_DIR}|g" "$CONFIG_DIR/openclaw.json"
    rm -f "$CONFIG_DIR/openclaw.json.bak"
    ok "Workspace paths resolved to: $WORKSPACES_DIR"
  fi
fi

# Seed workspace files (only if not already present)
WORKSPACE_FILES=(
  "workspaces/marketing/AGENTS.md"
  "workspaces/marketing/SOUL.md"
  "workspaces/marketing/HEARTBEAT.md"
  "workspaces/marketing/MEMORY.md"
)

for wf in "${WORKSPACE_FILES[@]}"; do
  src="$KIT_DIR/$wf"
  dst="$WORKSPACES_DIR/${wf#workspaces/}"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    ok "Seeded $(basename "$dst")"
  elif [ -f "$dst" ]; then
    warn "$(basename "$dst") already exists, skipping"
  fi
done

# Seed knowledge files
KNOWLEDGE_FILES=(
  "memory/brand-and-audience.md:marketing/memory/brand-and-audience.md"
  "strategies/campaign-playbook.md:marketing/strategies/campaign-playbook.md"
  "performance/baseline-metrics.md:marketing/performance/baseline-metrics.md"
  "content/memory/content-style-guide.md:marketing/memory/content-style-guide.md"
  "analytics/memory/market-research.md:marketing/memory/market-research.md"
)

for entry in "${KNOWLEDGE_FILES[@]}"; do
  src_rel="${entry%%:*}"
  dst_rel="${entry##*:}"
  src="$KIT_DIR/$src_rel"
  dst="$WORKSPACES_DIR/$dst_rel"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    ok "Seeded knowledge: $(basename "$dst")"
  elif [ -f "$dst" ]; then
    warn "Knowledge file exists, skipping: $(basename "$dst")"
  else
    warn "Source not found, skipping: $src_rel"
  fi
done

# Copy core marketing skills
for skill_dir in "$KIT_DIR"/workspaces/marketing/skills/core-marketing/*/; do
  skill_name="$(basename "$skill_dir")"
  dst="$WORKSPACES_DIR/marketing/skills/core-marketing/$skill_name"
  if [ ! -d "$dst" ]; then
    cp -r "$skill_dir" "$dst"
    ok "Installed skill: $skill_name"
  else
    warn "Skill already installed: $skill_name"
  fi
done

ok "Configuration and seed files in place"

# ============================================================================
# Step 7: Install Extensions (Plugins)
# ============================================================================
step 7 "Setting up extensions"

EXTENSIONS_TARGET="$CONFIG_DIR/extensions"
mkdir -p "$EXTENSIONS_TARGET"

for ext in marketing-feedback skill-audit; do
  src="$KIT_DIR/extensions/$ext"
  dst="$EXTENSIONS_TARGET/$ext"
  if [ -d "$src" ] && [ ! -d "$dst" ]; then
    cp -r "$src" "$dst"
    ok "Installed extension: $ext"
  elif [ -d "$dst" ]; then
    warn "Extension $ext already installed, skipping"
  fi
done

ok "Extensions installed"

# ============================================================================
# Step 8: Deploy Backup & Log Rotation
# ============================================================================
step 8 "Deploying backup and log rotation"

mkdir -p "$CONFIG_DIR/scripts"

# Deploy daily backup script
BACKUP_SRC="$KIT_DIR/scripts/daily-backup.sh"
BACKUP_DST="$CONFIG_DIR/scripts/daily-backup.sh"
if [ -f "$BACKUP_SRC" ]; then
  cp "$BACKUP_SRC" "$BACKUP_DST"
  chmod +x "$BACKUP_DST"
  ok "Deployed daily-backup.sh"
fi

# Generate and install launchd plist for daily backup
PLIST_DST="$HOME/Library/LaunchAgents/com.openclaw.daily-backup.plist"
if [[ "$(uname)" == "Darwin" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST_DST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.daily-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BACKUP_DST}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/openclaw/daily-backup.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclaw/daily-backup.err.log</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST" 2>/dev/null || true
  ok "Installed daily backup LaunchAgent (3:00 AM)"
fi

mkdir -p /tmp/openclaw
ok "Backup and log rotation deployed"

# ============================================================================
# Step 9: Install and Start Gateway Daemon
# ============================================================================
step 9 "Installing and starting gateway"

if command -v openclaw &>/dev/null; then
  info "Installing gateway daemon..."
  openclaw daemon install --force --runtime node 2>&1 || {
    warn "daemon install returned non-zero — trying manual bootstrap"
  }

  info "Restarting gateway daemon..."
  openclaw daemon restart 2>&1 || {
    warn "daemon restart returned non-zero"
    info "Try: openclaw doctor --repair"
  }

  # Brief wait for startup
  sleep 3

  if openclaw gateway status --require-rpc &>/dev/null 2>&1; then
    ok "Gateway running and RPC healthy"
  else
    warn "Gateway may not be fully started yet"
    info "Check manually: openclaw gateway status --require-rpc"
    info "Or run: openclaw doctor --repair"
  fi
else
  err "OpenClaw CLI not found after install — this should not happen"
  exit 1
fi

# ============================================================================
# Step 10: Health Check
# ============================================================================
step 10 "Running health check"

chmod +x "$KIT_DIR/scripts/health-check.sh"
if bash "$KIT_DIR/scripts/health-check.sh"; then
  ok "All health checks passed"
else
  warn "Some health checks failed — review output above"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  MarketClaw Kit Bootstrap Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Config dir:     $CONFIG_DIR"
echo "  Workspaces:     $WORKSPACES_DIR"
echo "  Environment:    $ENV_FILE"
echo ""
echo "  Useful commands:"
echo "    # Test agent"
echo "    openclaw agent --agent main -m 'List your available skills'"
echo ""
echo "    # Check health"
echo "    bash $KIT_DIR/scripts/health-check.sh"
echo ""
echo "    # View gateway logs"
echo "    tail -f /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log"
echo ""
echo "  Next steps:"
echo "    1. Configure Telegram channel:"
echo "       openclaw channels add --channel telegram --token '<BOT_TOKEN>'"
echo "       openclaw daemon restart"
echo "    2. Add first customer:"
echo "       cp customers/example.json customers/your-client.json"
echo "       bash scripts/provision-customer.sh create your-client"
echo "    3. See docs/quick-start.md for full guide"
echo ""
