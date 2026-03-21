#!/usr/bin/env bash
# ============================================================================
# configure-customer-crons.sh — Per-Customer Cron Job Manager
# ============================================================================
#
# Creates/removes per-customer cron jobs (weekly summary, monthly retrospective)
# based on the customer manifest's "reporting" configuration.
#
# Usage:
#   ./configure-customer-crons.sh <customerId>
#   ./configure-customer-crons.sh --remove <customerId>
#   ./configure-customer-crons.sh --dry-run <customerId>
#
# Fail-closed: if reporting.delivery.target is missing or empty, refuses to
# create cron jobs and exits with error.
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

# --- Argument Parsing ---
DRY_RUN=false
REMOVE=false
CUSTOMER_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      cat <<'EOF'
Usage: configure-customer-crons.sh [options] <customerId>

Options:
  --dry-run    Show what would be done without executing
  --remove     Remove cron jobs for this customer
  -h, --help   Show this help

Cron jobs created:
  {customerId}-weekly-summary       Weekly performance snapshot
  {customerId}-monthly-retrospective Monthly campaign retrospective

Fail-closed: refuses to create jobs if reporting.delivery.target is missing.
EOF
      exit 0
      ;;
    --dry-run) DRY_RUN=true; shift ;;
    --remove)  REMOVE=true; shift ;;
    *)
      if [[ -z "$CUSTOMER_ID" ]]; then
        CUSTOMER_ID="$1"; shift
      else
        err "Unknown argument: $1"; exit 1
      fi
      ;;
  esac
done

if [[ -z "$CUSTOMER_ID" ]]; then
  err "No customerId specified"
  exit 1
fi

# --- Derived paths ---
PROFILE="$CUSTOMER_ID"
MANIFEST="$CUSTOMERS_DIR/${CUSTOMER_ID}.json"

if [[ ! -f "$MANIFEST" ]]; then
  err "Customer manifest not found: $MANIFEST"
  exit 1
fi

# --- Read reporting config ---
read_reporting() {
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const r = m.reporting || {};
    const d = r.delivery || {};
    console.log(JSON.stringify({
      timezone: r.timezone || 'Asia/Shanghai',
      channel: d.channel || 'telegram',
      target: d.target || '',
      weeklyCron: (r.weekly && r.weekly.cron) || '0 9 * * 1',
      monthlyCron: (r.monthly && r.monthly.cron) || '0 9 1 * *',
      brandName: m.brandName || m.customerId || 'Customer'
    }));
  " "$MANIFEST"
}

REPORTING_JSON="$(read_reporting)"

# Extract all fields in one node process (avoids 6 separate node spawns)
eval "$(node -e "
  const r = JSON.parse(process.argv[1]);
  const esc = s => s.replace(/'/g, \"'\\\\''\");
  console.log('TIMEZONE=\'' + esc(r.timezone) + '\'');
  console.log('CHANNEL=\'' + esc(r.channel) + '\'');
  console.log('TARGET=\'' + esc(r.target) + '\'');
  console.log('WEEKLY_CRON=\'' + esc(r.weeklyCron) + '\'');
  console.log('MONTHLY_CRON=\'' + esc(r.monthlyCron) + '\'');
  console.log('BRAND_NAME=\'' + esc(r.brandName) + '\'');
" "$REPORTING_JSON")"

WEEKLY_NAME="${CUSTOMER_ID}-weekly-summary"
MONTHLY_NAME="${CUSTOMER_ID}-monthly-retrospective"

# --- Remove mode ---
if [[ "$REMOVE" == "true" ]]; then
  step "Removing cron jobs for: $CUSTOMER_ID"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would remove: $WEEKLY_NAME, $MONTHLY_NAME"
    exit 0
  fi

  if ! command -v openclaw &>/dev/null; then
    err "openclaw CLI not found"
    exit 1
  fi

  for name in "$WEEKLY_NAME" "$MONTHLY_NAME"; do
    local_id="$(openclaw --profile "$PROFILE" cron list --json 2>/dev/null \
      | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).jobs.find(j=>j.name==='${name}')?.id || ''" 2>/dev/null || echo "")"
    if [[ -n "$local_id" ]]; then
      if openclaw --profile "$PROFILE" cron remove "$local_id" 2>&1; then
        ok "Removed: $name ($local_id)"
      else
        warn "Failed to remove $name ($local_id)"
      fi
    else
      info "Not found (already removed): $name"
    fi
  done

  ok "Cron jobs removed for $CUSTOMER_ID"
  exit 0
fi

# --- Fail-closed: require delivery target ---
if [[ -z "$TARGET" ]]; then
  err "Fail-closed: reporting.delivery.target is empty or missing in $MANIFEST"
  err "Cannot create cron jobs without a delivery target."
  err "Add a valid target (e.g. Telegram chat ID) to the manifest's reporting.delivery.target field."
  exit 1
fi

# --- Create mode ---
step "Configuring cron jobs for: $CUSTOMER_ID"
info "Brand:    $BRAND_NAME"
info "Timezone: $TIMEZONE"
info "Channel:  $CHANNEL"
info "Target:   $TARGET"
info "Weekly:   $WEEKLY_CRON"
info "Monthly:  $MONTHLY_CRON"

if [[ "$DRY_RUN" == "true" ]]; then
  info "[DRY RUN] Would create:"
  info "  $WEEKLY_NAME  — cron: $WEEKLY_CRON"
  info "  $MONTHLY_NAME — cron: $MONTHLY_CRON"
  exit 0
fi

if ! command -v openclaw &>/dev/null; then
  err "openclaw CLI not found"
  exit 1
fi

# --- Cache cron list once (avoids repeated API calls per job) ---
CRON_LIST_JSON="$(openclaw --profile "$PROFILE" cron list --json 2>/dev/null || echo '{"jobs":[]}')"

# --- Helper: look up existing job ID by name from cached list ---
cron_id_by_name() {
  node -p "JSON.parse(process.argv[1]).jobs.find(j=>j.name===process.argv[2])?.id || ''" "$CRON_LIST_JSON" "$1" 2>/dev/null || echo ""
}

# --- Helper: create or update cron job (idempotent) ---
# Uses `cron edit` for existing jobs to preserve job ID and run history.
# Only creates a new job if none exists with the given name.
ensure_cron() {
  local name="$1"
  local cron_expr="$2"
  local message="$3"

  local existing_id
  existing_id="$(cron_id_by_name "$name")"

  if [[ -n "$existing_id" ]]; then
    info "Cron job '$name' already exists (id: $existing_id) — patching via cron edit"
    openclaw --profile "$PROFILE" cron edit "$existing_id" \
      --cron "$cron_expr" \
      --tz "$TIMEZONE" \
      --message "$message" \
      --announce --channel "$CHANNEL" --to "$TARGET" \
      --timeout-seconds 300 2>&1
    ok "Updated: $name ($existing_id)"
  else
    openclaw --profile "$PROFILE" cron add \
      --name "$name" \
      --agent main \
      --session isolated \
      --cron "$cron_expr" \
      --tz "$TIMEZONE" \
      --timeout-seconds 300 \
      --announce --channel "$CHANNEL" --to "$TARGET" \
      --message "$message" 2>&1
    ok "Created: $name"
  fi
}

# --- Weekly summary cron ---
WEEKLY_MSG="Weekly performance summary for ${BRAND_NAME}. Use the weekly-summary skill to:
1. List all active campaigns and their current phase
2. Pull click data from short links if configured
3. Compare actuals vs brief KPIs
4. Flag any at-risk campaigns (>20% behind target or blocked >3 days)
5. List specific action items
Write the summary to status/weekly-status.md (append, do not overwrite)."

ensure_cron "$WEEKLY_NAME" "$WEEKLY_CRON" "$WEEKLY_MSG"

# --- Monthly retrospective cron ---
MONTHLY_MSG="Monthly campaign retrospective for ${BRAND_NAME}. Use the campaign-retrospective skill to:
1. Identify campaigns completed this month
2. For each completed campaign, run a full retrospective
3. Extract lessons in 'If X, then Y' format
4. Append validated lessons to memory/campaign-lessons-learned.md
5. Write a monthly summary to status/monthly-status.md (append, do not overwrite) including: campaigns completed, KPI outcomes, lessons extracted, and skill gaps
6. Report skill gaps for the evolution system
If no campaigns completed this month, report that in status/monthly-status.md and skip the retrospective."

ensure_cron "$MONTHLY_NAME" "$MONTHLY_CRON" "$MONTHLY_MSG"

# --- Verify ---
step "Verifying cron jobs"
openclaw --profile "$PROFILE" cron list 2>&1 || warn "Could not list cron jobs"

echo ""
ok "Cron jobs configured for $CUSTOMER_ID"
info "Weekly:  $WEEKLY_NAME ($WEEKLY_CRON $TIMEZONE)"
info "Monthly: $MONTHLY_NAME ($MONTHLY_CRON $TIMEZONE)"
