#!/usr/bin/env bash
# ============================================================================
# provision-customer.sh — Multi-Client Gateway Instance Manager
# ============================================================================
#
# Manages per-customer OpenClaw gateway instances using --profile isolation.
# Each customer gets: independent config, state dir, workspace, LaunchAgent, port.
#
# Usage:
#   ./provision-customer.sh <command> <customerId>
#
# Commands:
#   create   — Provision new customer gateway instance
#   pause    — Stop customer gateway (preserves data)
#   resume   — Start customer gateway
#   status   — Check single customer gateway status
#   export   — Export customer data archive
#   destroy  — Stop gateway, archive data, cleanup
#
# Identity constraint: customerId = profile (for path/process isolation)
# NOTE: agent ID within each profile must be 'main' due to OpenClaw session
# path validation bug (always checks agents/main/sessions/). Profile-level
# isolation (separate state dirs) makes this safe — each profile's 'main'
# is fully independent.
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETING_DIR="$(dirname "$SCRIPT_DIR")"
CUSTOMERS_DIR="$MARKETING_DIR/customers"

# --- Usage ---
usage() {
  cat <<'EOF'
Usage: provision-customer.sh <command> <customerId>

Commands:
  create <id>    Provision new customer gateway instance
  pause <id>     Stop customer gateway
  resume <id>    Start customer gateway
  status <id>    Check customer gateway status
  export <id>    Export customer data archive
  destroy <id>   Stop + archive + cleanup

Options:
  -h, --help     Show this help
  --dry-run      Show what would be done (create only)
  --force        Skip confirmation prompts

Examples:
  ./provision-customer.sh create acme-corp
  ./provision-customer.sh pause acme-corp
  ./provision-customer.sh export acme-corp
EOF
  exit 0
}

# --- Argument Parsing ---
DRY_RUN=false
FORCE=false
COMMAND=""
CUSTOMER_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force)   FORCE=true; shift ;;
    create|pause|resume|status|export|destroy)
      COMMAND="$1"; shift
      ;;
    *)
      if [[ -z "$CUSTOMER_ID" ]]; then
        CUSTOMER_ID="$1"; shift
      else
        err "Unknown argument: $1"; usage
      fi
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  err "No command specified"
  usage
fi

if [[ -z "$CUSTOMER_ID" ]]; then
  err "No customerId specified"
  usage
fi

# --- Validate customerId format ---
if [[ ! "$CUSTOMER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  err "Invalid customerId: '$CUSTOMER_ID' (letters, numbers, hyphens, underscores only)"
  exit 1
fi

# --- Derived paths (from profile) ---
PROFILE="$CUSTOMER_ID"
STATE_DIR="$HOME/.openclaw-${PROFILE}"
CONFIG_PATH="$STATE_DIR/openclaw.json"
WORKSPACE_DIR="$STATE_DIR/workspaces/marketing"
MANIFEST="$CUSTOMERS_DIR/${CUSTOMER_ID}.json"
EXPORT_DIR="$MARKETING_DIR/exports"

# --- Helper: read manifest field ---
manifest_field() {
  local field="$1"
  if [[ ! -f "$MANIFEST" ]]; then
    err "Customer manifest not found: $MANIFEST"
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
    const val = data$(printf '["%s"]' "$field");
    if (val === undefined || val === null) process.exit(1);
    if (typeof val === 'object') console.log(JSON.stringify(val));
    else console.log(val);
  " 2>/dev/null
}

# --- Helper: read manifest field with default ---
manifest_field_or() {
  manifest_field "$1" 2>/dev/null || echo "$2"
}

# --- Helper: validate no port conflict ---
validate_port() {
  local port="$1"
  local conflicts=""

  for f in "$CUSTOMERS_DIR"/*.json; do
    [[ ! -f "$f" ]] && continue
    local fname
    fname="$(basename "$f" .json)"
    [[ "$fname" == "$CUSTOMER_ID" ]] && continue
    [[ "$fname" == "example" ]] && continue

    local other_port
    other_port="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf8')).port || '')" 2>/dev/null)"
    if [[ "$other_port" == "$port" ]]; then
      conflicts="$conflicts $fname(port=$other_port)"
    fi
  done

  # Also check if our own gateway uses this port
  if [[ "$port" == "18789" ]]; then
    conflicts="$conflicts operator-gateway(port=18789)"
  fi

  if [[ -n "$conflicts" ]]; then
    err "Port $port conflicts with:$conflicts"
    exit 1
  fi
}

# --- Helper: validate no state dir conflict ---
validate_state_dir() {
  if [[ -d "$STATE_DIR" ]] && [[ "$COMMAND" == "create" ]]; then
    err "State directory already exists: $STATE_DIR"
    err "Use 'destroy' first, or choose a different customerId"
    exit 1
  fi
}

# --- Helper: confirm action ---
confirm() {
  local msg="$1"
  if [[ "$FORCE" == "true" ]]; then
    return 0
  fi
  read -rp "$(echo -e "${YELLOW}$msg [y/N]${NC} ")" answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ============================================================================
# Command: create
# ============================================================================
cmd_create() {
  step "Provisioning customer: $CUSTOMER_ID"

  # Validate manifest exists
  if [[ ! -f "$MANIFEST" ]]; then
    err "Customer manifest not found: $MANIFEST"
    err "Create it first: cp $CUSTOMERS_DIR/example.json $MANIFEST"
    exit 1
  fi

  # Read all manifest fields in one node process (avoids 8+ separate node spawns)
  local manifest_all
  manifest_all="$(node -e "
    const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const r = {};
    r.port = m.port;
    r.brandName = m.brandName || '';
    r.audience = m.audience || '';
    r.modelProfile = m.modelProfile || {};
    r.skills = m.skills || [];
    r.sandbox = m.sandbox || {mode:'off'};
    r.tools = m.tools || {profile:'full'};
    r.hostBoundSkillsDenylist = m.hostBoundSkillsDenylist || [];
    console.log(JSON.stringify(r));
  " "$MANIFEST")" || { err "Failed to read manifest: $MANIFEST"; exit 1; }

  # Extract fields from cached JSON (single node process per field, reading from argv not file)
  local port brand_name audience model_profile skills_json sandbox_json tools_json host_bound_denylist
  port="$(node -p "JSON.parse(process.argv[1]).port" "$manifest_all")"
  brand_name="$(node -p "JSON.parse(process.argv[1]).brandName" "$manifest_all")"
  audience="$(node -p "JSON.parse(process.argv[1]).audience" "$manifest_all")"
  model_profile="$(node -p "JSON.stringify(JSON.parse(process.argv[1]).modelProfile)" "$manifest_all")"
  skills_json="$(node -p "JSON.stringify(JSON.parse(process.argv[1]).skills)" "$manifest_all")"
  sandbox_json="$(node -p "JSON.stringify(JSON.parse(process.argv[1]).sandbox)" "$manifest_all")"
  tools_json="$(node -p "JSON.stringify(JSON.parse(process.argv[1]).tools)" "$manifest_all")"
  host_bound_denylist="$(node -p "JSON.stringify(JSON.parse(process.argv[1]).hostBoundSkillsDenylist)" "$manifest_all")"

  info "Customer: $CUSTOMER_ID"
  info "Brand:    $brand_name"
  info "Port:     $port"
  info "Profile:  $PROFILE"
  info "State:    $STATE_DIR"

  # Validations
  validate_port "$port"
  validate_state_dir

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would create:"
    info "  State dir:  $STATE_DIR"
    info "  Config:     $CONFIG_PATH"
    info "  Workspace:  $WORKSPACE_DIR"
    info "  Port:       $port"
    info "  Skills:     $skills_json"
    return 0
  fi

  # --- Step 1: Create directories ---
  step "Creating directories"
  mkdir -p "$WORKSPACE_DIR/memory" "$WORKSPACE_DIR/skills"
  ok "Directories created"

  # --- Step 2: Generate gateway config ---
  step "Generating gateway config"

  node -e "
    const fs = require('fs');
    const config = {
      gateway: {
        mode: 'local',
        bind: 'loopback',
        port: ${port}
      },
      logging: {
        level: 'info',
        redactSensitive: 'tools'
      },
      diagnostics: {
        enabled: true,
        flags: ['gateway.*', 'session.*', 'webhook.*', 'agent.*']
      },
      memory: {
        backend: 'builtin',
        citations: 'auto',
        qmd: {
          paths: [
            { path: '${WORKSPACE_DIR}/memory/', name: 'Marketing Knowledge' }
          ],
          sessions: { enabled: true, retentionDays: 90 },
          update: { interval: '5m', embedInterval: '30m' },
          limits: { maxResults: 10, maxSnippetChars: 500 }
        }
      },
      agents: {
        defaults: {
          model: ${model_profile},
          sandbox: ${sandbox_json}
        },
        list: [
          {
            id: 'main',
            default: true,
            name: '${brand_name} Marketing Agent',
            workspace: '${WORKSPACE_DIR}',
            model: ${model_profile},
            skills: ${skills_json},
            tools: ${tools_json},
            memorySearch: { enabled: true },
            sandbox: ${sandbox_json}
          }
        ]
      },
      bindings: [
        {
          agentId: 'main',
          match: { channel: 'telegram', accountId: '*' }
        }
      ],
      session: {
        sendPolicy: {
          default: 'deny',
          rules: [
            { action: 'allow', match: { channel: 'telegram' } },
            { action: 'allow', match: { rawKeyPrefix: 'agent:main:' } }
          ]
        }
      },
      plugins: {
        enabled: true,
        entries: {
          telegram: { enabled: true }
        }
      },
      cron: {
        enabled: true,
        maxConcurrentRuns: 2
      }
    };

    fs.writeFileSync('${CONFIG_PATH}', JSON.stringify(config, null, 2));
  "
  ok "Config written: $CONFIG_PATH"

  # --- Step 3: Seed workspace files ---
  step "Seeding workspace"

  # Brand knowledge file
  cat > "$WORKSPACE_DIR/memory/brand-and-audience.md" <<BRAND_EOF
# Brand & Audience — ${brand_name}

## Brand
- **Name**: ${brand_name}

## Target Audience
${audience}

## Voice & Tone
(To be defined by operator during onboarding)

## Key Messages
(To be defined by operator during onboarding)
BRAND_EOF

  # SOUL.md — agent persona
  cat > "$WORKSPACE_DIR/SOUL.md" <<SOUL_EOF
# ${brand_name} Marketing Agent

You are the marketing agent for **${brand_name}**.
Your role is to help create, manage, and optimize marketing campaigns.

## Core Responsibilities
- Campaign ideation and planning
- Content creation and review
- Performance analysis and reporting
- Brand voice consistency

## Communication Style
- Professional and on-brand
- Data-informed recommendations
- Proactive suggestions when relevant
SOUL_EOF

  # AGENTS.md — task execution rules
  cat > "$WORKSPACE_DIR/AGENTS.md" <<AGENTS_EOF
# Task Execution Rules

## Campaign Workflow
Follow the 7-phase campaign lifecycle:
IDEATE → PLAN → CREATE → GATE → LAUNCH → ANALYZE → LEARN

## Constraints
- All content must align with brand voice (see memory/brand-and-audience.md)
- Get operator approval before launching campaigns
- Track all links with UTM parameters
AGENTS_EOF

  ok "Workspace seeded: $WORKSPACE_DIR"

  # --- Step 4: Copy marketing skills to customer workspace ---
  step "Distributing skills"

  local src_skills="$MARKETING_DIR/workspaces/marketing/skills/core-marketing"
  if [[ -d "$src_skills" ]]; then
    cp -r "$src_skills" "$WORKSPACE_DIR/skills/core-marketing"
    ok "Core marketing skills copied"
  else
    warn "Source skills not found at $src_skills — skipping"
  fi

  # --- Step 5: Apply host-bound skill denylist ---
  # Skills that share host state across profiles must be disabled
  local deny_count
  deny_count="$(node -e "console.log(JSON.parse('${host_bound_denylist}').length)" 2>/dev/null || echo 0)"
  if [[ "$deny_count" -gt 0 ]]; then
    info "Host-bound skills to deny: $deny_count"
    # Add skills.entries.<key>.enabled: false to the generated config
    node -e "
      const fs = require('fs');
      const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const denylist = JSON.parse(process.argv[2]);
      if (!config.skills) config.skills = {};
      if (!config.skills.entries) config.skills.entries = {};
      for (const skill of denylist) {
        config.skills.entries[skill] = { enabled: false };
      }
      fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2));
    " "$CONFIG_PATH" "$host_bound_denylist"
    ok "Host-bound skills disabled in config: $deny_count entries"
  fi

  # --- Step 6: Install and start gateway service ---
  # NOTE: exec is set to "deny" for customers (safest posture). Customer agents
  # interact via Telegram and curated marketing skills — no shell execution needed.
  # IMPORTANT: exec-approvals.json is shared across all profiles (not profile-scoped),
  # and all profiles use agent ID 'main', so allowlist mode would cause cross-customer
  # collisions. Do NOT switch to allowlist mode without upstream profile-scoping support.
  step "Installing gateway service"

  if command -v openclaw &>/dev/null; then
    info "Installing LaunchAgent for profile: $PROFILE"
    openclaw --profile "$PROFILE" gateway install 2>&1 || {
      warn "gateway install returned non-zero — may need manual setup"
    }

    info "Starting gateway..."
    openclaw --profile "$PROFILE" gateway start 2>&1 || {
      warn "gateway start returned non-zero — check: openclaw --profile $PROFILE gateway status"
    }

    # Brief wait for startup
    sleep 2

    # Verify
    if openclaw --profile "$PROFILE" gateway status --require-rpc &>/dev/null 2>&1; then
      ok "Gateway running on port $port"
    else
      warn "Gateway may not be fully started yet"
      info "Check manually: openclaw --profile $PROFILE gateway status"
    fi
  else
    warn "openclaw CLI not found — skipping gateway install/start"
    warn "Install openclaw, then run:"
    warn "  openclaw --profile $PROFILE gateway install"
    warn "  openclaw --profile $PROFILE gateway start"
  fi

  # --- Step 7: Update manifest status ---
  step "Finalizing"

  # Only mark active if gateway is confirmed running
  local final_status="provisioned"
  if command -v openclaw &>/dev/null; then
    if openclaw --profile "$PROFILE" gateway status --require-rpc &>/dev/null 2>&1; then
      final_status="active"
    else
      final_status="provisioned"
      warn "Gateway not confirmed running — manifest set to 'provisioned' (not 'active')"
      warn "After fixing gateway, run: bash marketing/scripts/provision-customer.sh resume $CUSTOMER_ID"
    fi
  fi

  node -e "
    const fs = require('fs');
    const manifest = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
    manifest.status = '${final_status}';
    manifest._provisionedAt = new Date().toISOString();
    fs.writeFileSync('$MANIFEST', JSON.stringify(manifest, null, 2));
  "

  echo ""
  if [[ "$final_status" == "active" ]]; then
    ok "Customer '$CUSTOMER_ID' provisioned and gateway running!"
  else
    warn "Customer '$CUSTOMER_ID' provisioned but gateway needs manual verification"
  fi
  echo ""
  info "Summary:"
  info "  Profile:   $PROFILE"
  info "  State:     $STATE_DIR"
  info "  Config:    $CONFIG_PATH"
  info "  Workspace: $WORKSPACE_DIR"
  info "  Port:      $port"
  info "  Status:    $final_status"
  echo ""
  info "Next steps:"
  info "  1. Add Telegram bot token:"
  info "     openclaw --profile $PROFILE channels add --channel telegram --token '<BOT_TOKEN>'"
  info "  2. Add API keys to auth profiles:"
  info "     Edit $STATE_DIR/agents/main/agent/auth-profiles.json"
  info "  3. Restart gateway to apply:"
  info "     openclaw --profile $PROFILE daemon restart"
  info "  4. Test: send a message to the Telegram bot"
}

# ============================================================================
# Command: pause
# ============================================================================
cmd_pause() {
  step "Pausing customer: $CUSTOMER_ID"

  if [[ ! -d "$STATE_DIR" ]]; then
    err "Customer state dir not found: $STATE_DIR"
    exit 1
  fi

  if command -v openclaw &>/dev/null; then
    openclaw --profile "$PROFILE" gateway stop 2>&1 || true
    ok "Gateway stopped for $CUSTOMER_ID"
  else
    err "openclaw CLI not found"
    exit 1
  fi

  # Update manifest
  if [[ -f "$MANIFEST" ]]; then
    node -e "
      const fs = require('fs');
      const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
      m.status = 'paused';
      m._pausedAt = new Date().toISOString();
      fs.writeFileSync('$MANIFEST', JSON.stringify(m, null, 2));
    "
  fi

  ok "Customer '$CUSTOMER_ID' paused"
}

# ============================================================================
# Command: resume
# ============================================================================
cmd_resume() {
  step "Resuming customer: $CUSTOMER_ID"

  if [[ ! -d "$STATE_DIR" ]]; then
    err "Customer state dir not found: $STATE_DIR"
    exit 1
  fi

  if command -v openclaw &>/dev/null; then
    openclaw --profile "$PROFILE" gateway start 2>&1 || {
      err "Failed to start gateway"
      info "Try: openclaw --profile $PROFILE gateway install && openclaw --profile $PROFILE gateway start"
      exit 1
    }

    # Wait briefly, then verify gateway is actually running
    sleep 2
    local resume_status="provisioned"
    if openclaw --profile "$PROFILE" gateway status --require-rpc &>/dev/null 2>&1; then
      resume_status="active"
      ok "Gateway confirmed running for $CUSTOMER_ID"
    else
      warn "Gateway start returned success but status probe failed"
      warn "Check manually: openclaw --profile $PROFILE gateway status"
    fi
  else
    err "openclaw CLI not found"
    exit 1
  fi

  # Update manifest — only mark active if gateway confirmed running
  if [[ -f "$MANIFEST" ]]; then
    node -e "
      const fs = require('fs');
      const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
      m.status = '${resume_status}';
      delete m._pausedAt;
      fs.writeFileSync('$MANIFEST', JSON.stringify(m, null, 2));
    "
  fi

  if [[ "$resume_status" == "active" ]]; then
    ok "Customer '$CUSTOMER_ID' resumed"
  else
    warn "Customer '$CUSTOMER_ID' resumed but gateway not confirmed — status set to 'provisioned'"
  fi
}

# ============================================================================
# Command: status
# ============================================================================
cmd_status() {
  if [[ ! -d "$STATE_DIR" ]]; then
    err "Customer state dir not found: $STATE_DIR"
    exit 1
  fi

  local port
  port="$(manifest_field "port" 2>/dev/null || echo "?")"
  local brand
  brand="$(manifest_field "brandName" 2>/dev/null || echo "?")"
  local manifest_status
  manifest_status="$(manifest_field "status" 2>/dev/null || echo "unknown")"

  echo -e "${CYAN}Customer: $CUSTOMER_ID${NC}"
  echo "  Brand:    $brand"
  echo "  Port:     $port"
  echo "  Manifest: $manifest_status"
  echo "  State:    $STATE_DIR"

  if command -v openclaw &>/dev/null; then
    echo -n "  Gateway:  "
    if openclaw --profile "$PROFILE" gateway status --require-rpc &>/dev/null 2>&1; then
      echo -e "${GREEN}running${NC}"
    else
      echo -e "${RED}stopped${NC}"
    fi
  else
    echo "  Gateway:  (openclaw CLI not available)"
  fi
}

# ============================================================================
# Command: export
# ============================================================================
cmd_export() {
  step "Exporting customer: $CUSTOMER_ID"

  if [[ ! -d "$STATE_DIR" ]]; then
    err "Customer state dir not found: $STATE_DIR"
    exit 1
  fi

  mkdir -p "$EXPORT_DIR"
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local archive="$EXPORT_DIR/${CUSTOMER_ID}-${timestamp}.tar.gz"
  local tar_file="$EXPORT_DIR/${CUSTOMER_ID}-${timestamp}.tar"

  info "Archiving state dir: $STATE_DIR"

  # Step 1: Create uncompressed tar with state dir
  tar -cf "$tar_file" \
    -C "$(dirname "$STATE_DIR")" \
    "$(basename "$STATE_DIR")"

  # Step 2: Append manifest
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local added_extras=false

  if [[ -f "$MANIFEST" ]]; then
    cp "$MANIFEST" "$tmp_dir/"
    added_extras=true
  fi

  # NOTE: exec-approvals.json is NOT exported. It is a shared file
  # (~/.openclaw/exec-approvals.json) not scoped to profiles, and customer
  # exec security is set to "deny" so no approvals should exist.

  if [[ "$added_extras" == "true" ]]; then
    tar -rf "$tar_file" -C "$tmp_dir" .
  fi
  rm -rf "$tmp_dir"

  # Step 3: Compress
  gzip -f "$tar_file"

  ok "Exported to: $archive"
  info "Size: $(du -h "$archive" | cut -f1)"
}

# ============================================================================
# Command: destroy
# ============================================================================
cmd_destroy() {
  step "Destroying customer: $CUSTOMER_ID"

  if [[ ! -d "$STATE_DIR" ]]; then
    warn "State dir not found: $STATE_DIR (may already be destroyed)"
  fi

  if ! confirm "This will stop the gateway and archive all data for '$CUSTOMER_ID'. Continue?"; then
    info "Aborted"
    exit 0
  fi

  # Stop gateway first
  if command -v openclaw &>/dev/null; then
    info "Stopping gateway..."
    openclaw --profile "$PROFILE" gateway stop 2>&1 || true
    openclaw --profile "$PROFILE" gateway uninstall 2>&1 || true
    ok "Gateway stopped and uninstalled"
  fi

  # Export before destroying
  if [[ -d "$STATE_DIR" ]]; then
    info "Creating final export..."
    cmd_export
  fi

  # Archive state dir
  if [[ -d "$STATE_DIR" ]]; then
    local archive_dir="$HOME/.openclaw-archives"
    mkdir -p "$archive_dir"
    local timestamp
    timestamp="$(date +%Y%m%d-%H%M%S)"
    mv "$STATE_DIR" "$archive_dir/${CUSTOMER_ID}-${timestamp}"
    ok "State dir archived to: $archive_dir/${CUSTOMER_ID}-${timestamp}"
  fi

  # Update manifest
  if [[ -f "$MANIFEST" ]]; then
    node -e "
      const fs = require('fs');
      const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
      m.status = 'disabled';
      m._destroyedAt = new Date().toISOString();
      fs.writeFileSync('$MANIFEST', JSON.stringify(m, null, 2));
    "
  fi

  ok "Customer '$CUSTOMER_ID' destroyed (data archived)"
}

# ============================================================================
# Dispatch
# ============================================================================
case "$COMMAND" in
  create)  cmd_create  ;;
  pause)   cmd_pause   ;;
  resume)  cmd_resume  ;;
  status)  cmd_status  ;;
  export)  cmd_export  ;;
  destroy) cmd_destroy ;;
  *)       err "Unknown command: $COMMAND"; usage ;;
esac
