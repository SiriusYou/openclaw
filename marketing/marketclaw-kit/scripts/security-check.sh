#!/usr/bin/env bash
# ============================================================================
# security-check.sh — Runtime Security Posture Validation
# ============================================================================
#
# Validates security configuration of customer gateway profiles.
#
# Usage:
#   bash marketing/scripts/security-check.sh --profile <id>
#   bash marketing/scripts/security-check.sh --all
#
# Checks:
#   1. Auth profiles valid (key or keyRef present for API key profiles)
#   2. Gateway binds to loopback only
#   3. exec.security === "deny" in runtime config
#   4. sendPolicy.default === "deny" in runtime config
#   5. No cross-profile path references in config
#
# Exit codes:
#   0 — All checks passed
#   1 — One or more checks failed
#   2 — Usage error
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

# --- Parse args ---
PROFILE=""
CHECK_ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --all)
      CHECK_ALL=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 --profile <id> | --all"
      echo ""
      echo "Validate runtime security posture of customer gateway profiles."
      echo ""
      echo "Options:"
      echo "  --profile <id>   Check a single profile"
      echo "  --all            Check all discovered customer profiles"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PROFILE" ]] && [[ "$CHECK_ALL" == "false" ]]; then
  echo "Error: specify --profile <id> or --all" >&2
  exit 2
fi

# --- Helpers ---
pass_count=0
fail_count=0
warn_count=0

pass() { echo -e "  ${GREEN}PASS${NC}  $*"; pass_count=$((pass_count + 1)); }
fail() { echo -e "  ${RED}FAIL${NC}  $*"; fail_count=$((fail_count + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $*"; warn_count=$((warn_count + 1)); }
info() { echo -e "  ${DIM}INFO${NC}  $*"; }

# --- Discovery (shared predicate) ---
# shellcheck source=lib-discover-profiles.sh
source "$(dirname "$0")/lib-discover-profiles.sh"

# --- Check a single profile ---
check_profile() {
  local id="$1"
  local state_dir="$HOME/.openclaw-${id}"
  local config_file="$state_dir/openclaw.json"
  local auth_file="$state_dir/agents/main/agent/auth-profiles.json"

  echo ""
  echo -e "${DIM}─── Profile: ${NC}${id}${DIM} ───${NC}"

  # 0. State dir exists
  if [[ ! -d "$state_dir" ]]; then
    fail "State directory missing: $state_dir"
    return
  fi

  # 1. Auth profiles check
  if [[ -f "$auth_file" ]]; then
    local auth_valid
    auth_valid=$(node -e "
      const store = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const profiles = store.profiles || {};
      const keys = Object.keys(profiles);
      if (keys.length === 0) { console.log('empty'); process.exit(0); }
      let valid = 0;
      for (const [k, v] of Object.entries(profiles)) {
        if (v.type === 'api_key' && (v.key || v.keyRef)) valid++;
        else if (v.type === 'token' && (v.token || v.tokenRef)) valid++;
        else if (v.type === 'oauth') valid++; // OAuth expiry not checked here — use 'openclaw doctor' for full validation
      }
      console.log(valid > 0 ? 'ok:' + valid : 'invalid');
    " "$auth_file" 2>/dev/null) || auth_valid="error"

    case "$auth_valid" in
      ok:*) pass "Auth profiles valid (${auth_valid#ok:} credential(s))" ;;
      empty) fail "Auth profiles file exists but has no profiles" ;;
      invalid) fail "Auth profiles exist but none have valid credentials" ;;
      error) fail "Failed to parse auth-profiles.json" ;;
    esac
  else
    fail "Auth profiles file missing: $auth_file"
  fi

  # 2-5. Config checks (single node call for efficiency)
  if [[ -f "$config_file" ]]; then
    local config_result
    config_result=$(node -e "
      const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const results = [];

      // 2. Gateway bind
      const bind = c.gateway?.bind || 'any';
      results.push(bind === 'loopback' ? 'PASS|Gateway binds to loopback' : 'FAIL|Gateway bind is \"' + bind + '\" (expected loopback)');

      // 3. Exec security
      const agent = c.agents?.list?.[0];
      const execSec = agent?.tools?.exec?.security || 'unknown';
      results.push(execSec === 'deny' ? 'PASS|exec.security is deny' : 'FAIL|exec.security is \"' + execSec + '\" (expected deny)');

      // 4. sendPolicy
      const sendDefault = c.session?.sendPolicy?.default || 'unknown';
      results.push(sendDefault === 'deny' ? 'PASS|sendPolicy.default is deny' : 'FAIL|sendPolicy.default is \"' + sendDefault + '\" (expected deny)');

      // 5. Cross-profile path references
      const configStr = JSON.stringify(c);
      const profileId = process.argv[2];
      const escaped = profileId.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\\\$&');
      const re = new RegExp('\\\\.openclaw-(?!' + escaped + '[/\"\\\\\\\\])[a-zA-Z0-9_-]+');
      const crossRef = re.test(configStr);
      results.push(!crossRef ? 'PASS|No cross-profile path references' : 'FAIL|Config contains references to other profiles');

      // 6. Only main agent
      const agentCount = c.agents?.list?.length || 0;
      results.push(agentCount === 1 ? 'PASS|Single agent (main) only' : 'FAIL|Found ' + agentCount + ' agents (expected 1)');

      // 7. Host-bound skills disabled
      const skillEntries = c.skills?.entries || {};
      const hostBound = ['things-mac', 'tmux', '1password'];
      const allDisabled = hostBound.every(s => skillEntries[s]?.enabled === false);
      results.push(allDisabled ? 'PASS|Host-bound skills disabled' : 'WARN|Some host-bound skills not explicitly disabled');

      // 8. fs.workspaceOnly
      const wsOnly = agent?.tools?.fs?.workspaceOnly;
      results.push(wsOnly === true ? 'PASS|fs.workspaceOnly is true' : 'FAIL|fs.workspaceOnly is not true');

      console.log(results.join('\\n'));
    " "$config_file" "$id" 2>/dev/null) || {
      fail "Failed to parse config: $config_file"
      return
    }

    while IFS='|' read -r status msg; do
      case "$status" in
        PASS) pass "$msg" ;;
        FAIL) fail "$msg" ;;
        WARN) warn "$msg" ;;
      esac
    done <<< "$config_result"
  else
    fail "Config file missing: $config_file"
  fi
}

# --- Main ---
echo ""
echo -e "${DIM}═══ Security Posture Check ═══${NC}"

if [[ "$CHECK_ALL" == "true" ]]; then
  profiles=($(discover_profiles))
  if [[ ${#profiles[@]} -eq 0 ]]; then
    info "No customer profiles discovered"
    exit 0
  fi
  for p in "${profiles[@]}"; do
    check_profile "$p"
  done
else
  check_profile "$PROFILE"
fi

# --- Summary ---
echo ""
echo -e "${DIM}───────────────────────────────${NC}"
total=$((pass_count + fail_count + warn_count))
echo -e "  Passed: ${GREEN}${pass_count}${NC}  Failed: ${RED}${fail_count}${NC}  Warnings: ${YELLOW}${warn_count}${NC}  Total: ${total}"
echo ""

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
exit 0
