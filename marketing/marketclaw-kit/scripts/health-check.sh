#!/usr/bin/env bash
# ============================================================================
# health-check.sh — Post-Install Verification
# ============================================================================
#
# Validates that the MarketClaw Kit installation is healthy:
#   1. OpenClaw CLI version (>= 2026.3.x)
#   2. Gateway process + RPC probe
#   3. Auth profiles (chain-compatible: google or openrouter)
#   4. Workspace directory structure
#   5. Core marketing skills (9 required)
#
# Usage:
#   ./health-check.sh [--profile <name>]
#
# Exit code: 0 = all pass, 1 = one or more failures
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC}  $*"; }
fail() { echo -e "  ${RED}FAIL${NC}  $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $*"; }
info() { echo -e "  ${BLUE}INFO${NC}  $*"; }

FAILURES=0
PROFILE_ARG=""
PROFILE_FLAG=""

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE_ARG="$2"
      PROFILE_FLAG="--profile $2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--profile <name>]"
      echo ""
      echo "Verify MarketClaw Kit installation health."
      echo "  --profile <name>  Check a specific customer profile"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# --- Derive paths ---
if [[ -n "$PROFILE_ARG" ]]; then
  STATE_DIR="$HOME/.openclaw-${PROFILE_ARG}"
  AUTH_DIR="$STATE_DIR/agents/main/agent"
  WORKSPACE_DIR="$STATE_DIR/workspaces/marketing"
else
  STATE_DIR="$HOME/.openclaw"
  AUTH_DIR="$STATE_DIR/agents/main/agent"
  WORKSPACE_DIR="$STATE_DIR/workspaces/marketing"
fi

echo ""
echo -e "${BLUE}MarketClaw Kit — Health Check${NC}"
if [[ -n "$PROFILE_ARG" ]]; then
  echo -e "${BLUE}Profile: ${PROFILE_ARG}${NC}"
fi
echo ""

# ============================================================================
# Check 1: OpenClaw CLI
# ============================================================================
echo "1. OpenClaw CLI"

if command -v openclaw &>/dev/null; then
  CLI_VERSION="$(openclaw --version 2>/dev/null || echo "unknown")"
  pass "CLI found: $CLI_VERSION"

  # Check version >= 2026.3
  if [[ "$CLI_VERSION" =~ ^OpenClaw\ 20[2-9][0-9]\.[3-9] ]] || [[ "$CLI_VERSION" =~ ^OpenClaw\ 20[2-9][0-9]\.[1-9][0-9] ]]; then
    pass "CLI version compatible"
  else
    warn "CLI version may be outdated: $CLI_VERSION (recommend >= 2026.3.x)"
  fi
else
  fail "OpenClaw CLI not found (install: npm i -g openclaw@latest)"
fi

# ============================================================================
# Check 2: Gateway Process + RPC
# ============================================================================
echo ""
echo "2. Gateway"

if command -v openclaw &>/dev/null; then
  # shellcheck disable=SC2086
  if openclaw $PROFILE_FLAG gateway status --require-rpc &>/dev/null 2>&1; then
    pass "Gateway running, RPC healthy"
  else
    # Try without RPC
    # shellcheck disable=SC2086
    if openclaw $PROFILE_FLAG gateway status &>/dev/null 2>&1; then
      fail "Gateway service loaded but RPC probe failed"
    else
      fail "Gateway not running"
    fi
  fi
else
  fail "Cannot check gateway (CLI not found)"
fi

# ============================================================================
# Check 3: Auth Profiles (chain-compatible)
# ============================================================================
echo ""
echo "3. Authentication"

AUTH_FILE="$AUTH_DIR/auth-profiles.json"
if [[ -f "$AUTH_FILE" ]]; then
  pass "Auth profiles file exists"

  # Check for chain-compatible profiles (google or openrouter)
  CHAIN_COMPAT="$(node -e "
    const fs = require('fs');
    const store = JSON.parse(fs.readFileSync('$AUTH_FILE', 'utf8'));
    const profiles = store.profiles || {};
    const keys = Object.keys(profiles);
    const compat = keys.filter(k => k.startsWith('google:') || k.startsWith('openrouter:'));
    console.log(compat.length);
  " 2>/dev/null || echo "0")"

  if [[ "$CHAIN_COMPAT" -gt 0 ]]; then
    pass "Chain-compatible auth profile found ($CHAIN_COMPAT profile(s): google or openrouter)"
  else
    TOTAL_PROFILES="$(node -e "
      const store = JSON.parse(require('fs').readFileSync('$AUTH_FILE', 'utf8'));
      console.log(Object.keys(store.profiles || {}).length);
    " 2>/dev/null || echo "0")"

    if [[ "$TOTAL_PROFILES" -gt 0 ]]; then
      fail "Auth profiles exist ($TOTAL_PROFILES) but none are chain-compatible (need google:* or openrouter:*)"
      info "Kit model chain: google/gemini-3-pro-preview → openrouter/auto"
    else
      fail "No auth profiles configured"
    fi
  fi
else
  fail "Auth profiles file not found: $AUTH_FILE"
  info "Run setup.sh or add API keys manually"
fi

# ============================================================================
# Check 4: Workspace Structure
# ============================================================================
echo ""
echo "4. Workspace"

if [[ -d "$WORKSPACE_DIR" ]]; then
  pass "Marketing workspace exists: $WORKSPACE_DIR"

  for wfile in AGENTS.md SOUL.md HEARTBEAT.md; do
    if [[ -f "$WORKSPACE_DIR/$wfile" ]]; then
      pass "$wfile present"
    else
      fail "$wfile missing from workspace"
    fi
  done

  if [[ -d "$WORKSPACE_DIR/memory" ]]; then
    pass "memory/ directory exists"
  else
    fail "memory/ directory missing"
  fi
else
  fail "Marketing workspace not found: $WORKSPACE_DIR"
fi

# ============================================================================
# Check 5: Core Marketing Skills (9 required)
# ============================================================================
echo ""
echo "5. Skills"

REQUIRED_SKILLS=(
  campaign-brief
  campaign-decision-gate
  campaign-diagnosis
  campaign-lifecycle
  campaign-retrospective
  content-ab-test
  content-repurposing
  structured-brainstorm
  weekly-summary
)

SKILLS_DIR="$WORKSPACE_DIR/skills/core-marketing"
SKILL_COUNT=0

for skill in "${REQUIRED_SKILLS[@]}"; do
  skill_path="$SKILLS_DIR/$skill/SKILL.md"
  if [[ -f "$skill_path" ]]; then
    SKILL_COUNT=$((SKILL_COUNT + 1))
  else
    fail "Skill missing: $skill (expected at $skill_path)"
  fi
done

if [[ "$SKILL_COUNT" -eq ${#REQUIRED_SKILLS[@]} ]]; then
  pass "All 9 core marketing skills present"
else
  fail "Only $SKILL_COUNT/${#REQUIRED_SKILLS[@]} skills found"
fi

# ============================================================================
# Report
# ============================================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${GREEN}  ALL CHECKS PASSED${NC}"
else
  echo -e "${RED}  $FAILURES CHECK(S) FAILED${NC}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit "$( [[ "$FAILURES" -eq 0 ]] && echo 0 || echo 1 )"
