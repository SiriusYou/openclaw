#!/usr/bin/env bash
# ============================================================================
# OpenClaw Marketing Agent System — One-Click Bootstrap
# ============================================================================
#
# Usage:
#   chmod +x setup.sh && ./setup.sh
#
# Prerequisites:
#   - Docker Engine 24+ with Compose V2
#   - Node.js 20+ (for clawhub CLI)
#   - openssl (for token generation)
#
# This script:
#   1. Checks prerequisites
#   2. Generates secrets (.env)
#   3. Builds Docker images
#   4. Creates workspace directories & seed files
#   5. Copies config templates
#   6. Starts core services
#   7. Verifies health
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
OPENCLAW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MARKETING_DIR="$SCRIPT_DIR"
WORKSPACES_DIR="$MARKETING_DIR/workspaces"
CONFIG_DIR="$HOME/.openclaw"
ENV_FILE="$MARKETING_DIR/.env"

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

check_cmd docker   || MISSING=1
check_cmd node     || MISSING=1
check_cmd openssl  || MISSING=1

# Check Docker Compose V2
if docker compose version &>/dev/null; then
  ok "Docker Compose V2: $(docker compose version --short 2>/dev/null || echo 'available')"
else
  err "Docker Compose V2 not available. Install: https://docs.docker.com/compose/install/"
  MISSING=1
fi

# Check Docker daemon running
if docker info &>/dev/null 2>&1; then
  ok "Docker daemon is running"
else
  err "Docker daemon is not running. Start Docker first."
  MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
  err "Missing prerequisites. Install them and re-run."
  exit 1
fi

ok "All prerequisites satisfied"

# ============================================================================
# Step 2: Generate Secrets & .env File
# ============================================================================
step 2 "Setting up environment variables"

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
# OpenClaw Marketing Agent System — Environment Variables
# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# ============================================================================

# --- LLM Providers ---
# If you used 'openclaw onboard' with subscription auth, leave these commented out.
# Only set if using API keys instead of subscription.
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...

# --- Gateway ---
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
OPENCLAW_GATEWAY_BIND=loopback
OPENCLAW_GATEWAY_PORT=18789

# --- Paths ---
OPENCLAW_CONFIG_DIR=${CONFIG_DIR}
OPENCLAW_WORKSPACE_DIR=${WORKSPACES_DIR}

# --- Diagnostics ---
OPENCLAW_DIAGNOSTICS=1

# --- Channel Tokens (Phase 1+) ---
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...

# --- Marketing Platform APIs (Phase 2+) ---
# HUBSPOT_API_KEY=
# GOOGLE_ANALYTICS_KEY=
# META_ADS_TOKEN=

# --- Cost Control ---
# ANTHROPIC_API_KEY_2=sk-ant-...   (rotation key for rate limits)
EOF

  ok "Generated .env with gateway token: ${GATEWAY_TOKEN:0:8}..."
  info "Using subscription auth from 'openclaw onboard'. No API key needed in .env."
fi

# ============================================================================
# Step 3: Build Docker Images
# ============================================================================
step 3 "Building Docker images"

cd "$OPENCLAW_ROOT"

info "Building openclaw:local (gateway) — this may take a few minutes..."
if docker build -t openclaw:local . 2>&1 | tail -5; then
  ok "openclaw:local built"
else
  err "Failed to build openclaw:local"
  exit 1
fi

info "Building openclaw-sandbox:bookworm-slim..."
if docker build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox . 2>&1 | tail -5; then
  ok "openclaw-sandbox:bookworm-slim built"
else
  warn "Sandbox build failed (non-critical, tool execution will use host)"
fi

info "Building openclaw-sandbox-browser:bookworm-slim..."
if docker build -t openclaw-sandbox-browser:bookworm-slim -f Dockerfile.sandbox-browser . 2>&1 | tail -5; then
  ok "openclaw-sandbox-browser:bookworm-slim built"
else
  warn "Browser sandbox build failed (non-critical, can add later in Phase 6)"
fi

cd "$MARKETING_DIR"

info "Docker images:"
docker images --format "  {{.Repository}}:{{.Tag}} ({{.Size}})" | grep -E "openclaw" || true

# ============================================================================
# Step 4: Create Workspace Directories
# ============================================================================
step 4 "Creating workspace directories"

# Marketing Orchestrator workspace
mkdir -p "$WORKSPACES_DIR/marketing/skills/meta"
mkdir -p "$WORKSPACES_DIR/marketing/skills/core-marketing"
mkdir -p "$WORKSPACES_DIR/marketing/skills/platform"
mkdir -p "$WORKSPACES_DIR/marketing/skills/evolved"
mkdir -p "$WORKSPACES_DIR/marketing/memory"
mkdir -p "$WORKSPACES_DIR/marketing/performance"
mkdir -p "$WORKSPACES_DIR/marketing/strategies"

# Content Writer workspace
mkdir -p "$WORKSPACES_DIR/content/skills"
mkdir -p "$WORKSPACES_DIR/content/memory"

# Analytics workspace
mkdir -p "$WORKSPACES_DIR/analytics/skills"
mkdir -p "$WORKSPACES_DIR/analytics/memory"

# .gitkeep for evolved skills
touch "$WORKSPACES_DIR/marketing/skills/evolved/.gitkeep"

ok "Workspace directories created"

# ============================================================================
# Step 5: Copy Config & Seed Files
# ============================================================================
step 5 "Copying configuration and seed files"

# Create config directory
mkdir -p "$CONFIG_DIR"

# Copy config.json5
if [ ! -f "$CONFIG_DIR/config.json5" ]; then
  cp "$MARKETING_DIR/config.json5" "$CONFIG_DIR/config.json5"
  ok "Copied config.json5 to $CONFIG_DIR/"
else
  warn "config.json5 already exists in $CONFIG_DIR/, skipping"
fi

# Seed MEMORY.md files (only if not already present)
for agent_dir in marketing content analytics; do
  src="$MARKETING_DIR/workspaces/$agent_dir/MEMORY.md"
  dst="$WORKSPACES_DIR/$agent_dir/MEMORY.md"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    ok "Seeded $dst"
  elif [ -f "$dst" ]; then
    warn "$dst already exists, skipping"
  fi
done

# Copy custom skill templates
for skill_dir in campaign-brief content-ab-test; do
  src="$MARKETING_DIR/workspaces/marketing/skills/core-marketing/$skill_dir/SKILL.md"
  dst="$WORKSPACES_DIR/marketing/skills/core-marketing/$skill_dir/SKILL.md"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    ok "Installed skill: $skill_dir"
  fi
done

ok "Configuration and seed files in place"

# ============================================================================
# Step 6: Install Extensions (Plugins)
# ============================================================================
step 6 "Setting up extensions"

EXTENSIONS_TARGET="$CONFIG_DIR/extensions"
mkdir -p "$EXTENSIONS_TARGET"

for ext in marketing-feedback skill-audit; do
  src="$MARKETING_DIR/extensions/$ext"
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
# Step 7: Init Evolved Skills Git Repo
# ============================================================================
step 7 "Initializing evolved skills repository"

EVOLVED_DIR="$WORKSPACES_DIR/marketing/skills/evolved"
if [ ! -d "$EVOLVED_DIR/.git" ]; then
  cd "$EVOLVED_DIR"
  git init -q
  cat > README.md <<'GITEOF'
# Evolved Skills

Agent-generated skills. Review before merging into production.

## Safety

All skills in this directory are validated by the `skill-audit` extension hook
before being loaded. Skills containing dangerous patterns (exec, eval,
child_process, rm -rf, etc.) are blocked automatically.
GITEOF
  git add . && git commit -q -m "init evolved skills repo"
  cd "$MARKETING_DIR"
  ok "Evolved skills git repo initialized"
else
  warn "Evolved skills repo already initialized"
fi

# ============================================================================
# Step 8: Validate .env Before Starting Services
# ============================================================================
step 8 "Validating configuration"

# Source .env to check critical vars
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

VALID=1

# Check for auth: either API key in .env OR subscription auth-profiles from onboard
HAS_API_KEY=0
HAS_SUBSCRIPTION=0

if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY:-}" != "sk-ant-REPLACE_ME" ]; then
  HAS_API_KEY=1
  ok "API key found in .env"
fi

if [ -f "$CONFIG_DIR/agents/main/agent/auth-profiles.json" ]; then
  HAS_SUBSCRIPTION=1
  ok "Subscription auth-profiles found (from openclaw onboard)"
fi

if [ "$HAS_API_KEY" -eq 0 ] && [ "$HAS_SUBSCRIPTION" -eq 0 ]; then
  err "No authentication found. Either:"
  err "  - Set ANTHROPIC_API_KEY in $ENV_FILE, or"
  err "  - Run 'openclaw onboard' to configure subscription auth"
  VALID=0
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  err "OPENCLAW_GATEWAY_TOKEN not set"
  VALID=0
fi

if [ "$VALID" -eq 0 ]; then
  echo ""
  warn "Configuration incomplete. Fix the above issues, then run:"
  echo ""
  echo "  cd $MARKETING_DIR"
  echo "  docker compose -f docker-compose.marketing.yml up -d"
  echo ""
  echo "Or re-run this script after fixing."
  exit 0
fi

ok "Configuration valid"

# ============================================================================
# Step 9: Start Services
# ============================================================================
step 9 "Starting services"

cd "$MARKETING_DIR"

info "Starting core services (gateway + sandboxes)..."
docker compose -f docker-compose.marketing.yml up -d

info "Waiting for gateway health check..."
RETRIES=0
MAX_RETRIES=30
while [ "$RETRIES" -lt "$MAX_RETRIES" ]; do
  if curl -sf "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/health" &>/dev/null; then
    ok "Gateway is healthy!"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 2
done

if [ "$RETRIES" -eq "$MAX_RETRIES" ]; then
  warn "Gateway health check timed out. Check logs:"
  echo "  docker compose -f docker-compose.marketing.yml logs openclaw-gateway"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Marketing Agent System Bootstrap Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Config dir:     $CONFIG_DIR"
echo "  Workspaces:     $WORKSPACES_DIR"
echo "  Compose file:   $MARKETING_DIR/docker-compose.marketing.yml"
echo "  Environment:    $ENV_FILE"
echo ""
echo "  Useful commands:"
echo "    # View logs"
echo "    docker compose -f $MARKETING_DIR/docker-compose.marketing.yml logs -f"
echo ""
echo "    # Run CLI interactively"
echo "    docker compose -f $MARKETING_DIR/docker-compose.marketing.yml run --rm openclaw-cli"
echo ""
echo "    # Test orchestrator"
echo "    docker compose -f $MARKETING_DIR/docker-compose.marketing.yml run --rm openclaw-cli agent \\"
echo "      --id marketing-orchestrator --message 'List your available skills'"
echo ""
echo "    # View browser sandbox"
echo "    open http://127.0.0.1:6080"
echo ""
echo "    # Stop services"
echo "    docker compose -f $MARKETING_DIR/docker-compose.marketing.yml down"
echo ""
echo "  Next steps:"
echo "    1. Configure Slack channel (Phase 1.3)"
echo "    2. Install skills from ClawHub (Phase 2.2)"
echo "    3. Set up knowledge ingestion (Phase 3)"
echo ""
