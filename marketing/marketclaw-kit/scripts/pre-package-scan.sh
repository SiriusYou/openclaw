#!/usr/bin/env bash
# ============================================================================
# pre-package-scan.sh — Secret Leak Detection Scanner
# ============================================================================
#
# Scans the repository for leaked secrets before packaging marketclaw-kit.
# Exit code 1 if any secrets found, 0 if clean.
#
# Usage:
#   ./pre-package-scan.sh [--fix] [<directory>]
#
# Default directory: parent of this script's directory (marketing/)
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[LEAK]${NC}  $*"; }

# --- Arguments ---
SCAN_DIR=""
SHOW_FIX=false

for arg in "$@"; do
  case "$arg" in
    --fix)  SHOW_FIX=true ;;
    -h|--help)
      echo "Usage: $0 [--fix] [<directory>]"
      echo ""
      echo "Scan for leaked secrets in the packaging directory."
      echo "  --fix    Show remediation hints for each finding"
      echo ""
      echo "Default scan target: marketing/ directory"
      exit 0
      ;;
    *)
      if [[ -z "$SCAN_DIR" ]]; then
        SCAN_DIR="$arg"
      fi
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN_DIR="${SCAN_DIR:-$(dirname "$SCRIPT_DIR")}"

if [[ ! -d "$SCAN_DIR" ]]; then
  echo "Directory not found: $SCAN_DIR" >&2
  exit 1
fi

info "Scanning: $SCAN_DIR"
echo ""

# --- Secret patterns ---
# Each pattern: "name|regex|description|fix_hint"
PATTERNS=(
  'OpenAI API Key|sk-[a-zA-Z0-9_-]{20,}|OpenAI API key (sk-...)|Move to auth-profiles.json or env var'
  'GitHub PAT|ghp_[a-zA-Z0-9]{36,}|GitHub personal access token|Use env var or GitHub App'
  'GitHub OAuth|gho_[a-zA-Z0-9]{36,}|GitHub OAuth token|Use env var'
  'GitHub App Token|ghs_[a-zA-Z0-9]{36,}|GitHub App installation token|Use env var'
  'Telegram Bot Token|[0-9]{8,10}:[A-Za-z0-9_-]{35}|Telegram bot token|Use openclaw channels add --token'
  'Slack Bot Token|xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}|Slack bot token|Use env var'
  'Discord Bot Token|[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9-_]{6}\.[A-Za-z0-9-_]{27,}|Discord bot token|Use env var'
  'AWS Access Key|AKIA[0-9A-Z]{16}|AWS access key ID|Use AWS credentials file'
  'Generic Secret|(?i)(api[_-]?key|api[_-]?secret|auth[_-]?token|secret[_-]?key)\s*[:=]\s*["\x27][a-zA-Z0-9_/+=-]{16,}["\x27]|Hardcoded API key/secret|Use env var or auth profiles'
  'Private Key Block|-----BEGIN (RSA |EC )?PRIVATE KEY-----|Private key in source|Store in secure keychain'
  'Short.io Key|sk_[A-Za-z0-9]{16,}|Short.io API key|Use env var'
)

# Files to skip (binary, generated, node_modules)
SKIP_PATTERNS=(
  "node_modules"
  ".git/"
  "dist/"
  "*.tar.gz"
  "*.zip"
  "*.png"
  "*.jpg"
  "*.ico"
  "*.woff"
  "*.woff2"
  "*.ttf"
  ".env.example"
  "pre-package-scan.sh"
)

# Build grep exclude args
EXCLUDE_ARGS=()
for skip in "${SKIP_PATTERNS[@]}"; do
  if [[ "$skip" == *"/"* ]]; then
    EXCLUDE_ARGS+=(--exclude-dir="${skip%/}")
  else
    EXCLUDE_ARGS+=(--exclude="$skip")
  fi
done

# --- Scan ---
leak_count=0
file_count=0

for pattern_def in "${PATTERNS[@]}"; do
  IFS='|' read -r name regex desc fix_hint <<< "$pattern_def"

  # Use grep with extended regex
  matches=""
  matches=$(grep -rn -E "$regex" "$SCAN_DIR" "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)

  if [[ -n "$matches" ]]; then
    while IFS= read -r match; do
      leak_count=$((leak_count + 1))
      # Make path relative
      relative="${match#$SCAN_DIR/}"
      err "$name: $relative"
      if [[ "$SHOW_FIX" == "true" ]]; then
        echo -e "     ${YELLOW}Fix: $fix_hint${NC}"
      fi
    done <<< "$matches"
  fi
done

# --- Also check for .env files that shouldn't be packaged ---
env_files=$(find "$SCAN_DIR" -name ".env" -o -name ".env.local" -o -name ".env.production" 2>/dev/null | grep -v ".env.example" || true)
if [[ -n "$env_files" ]]; then
  while IFS= read -r envf; do
    leak_count=$((leak_count + 1))
    relative="${envf#$SCAN_DIR/}"
    err "Env file should not be packaged: $relative"
    if [[ "$SHOW_FIX" == "true" ]]; then
      echo -e "     ${YELLOW}Fix: Add to .gitignore and remove from package${NC}"
    fi
  done <<< "$env_files"
fi

# --- Report ---
echo ""
if [[ "$leak_count" -eq 0 ]]; then
  ok "No secrets detected — safe to package"
  exit 0
else
  err "Found $leak_count potential secret(s)"
  echo ""
  echo -e "${RED}DO NOT package until all leaks are resolved.${NC}"
  echo "Run with --fix for remediation hints."
  exit 1
fi
