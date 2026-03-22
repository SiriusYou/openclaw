#!/usr/bin/env bash
# ============================================================================
# customer-status.sh — Multi-Customer Gateway Status Aggregator
# ============================================================================
#
# Iterates all customer manifests and reports gateway status for each.
# Includes cost alert status (from cost-report-latest.json) and backup
# freshness (from ~/.openclaw/backups/customers/{id}/).
#
# Usage:
#   ./customer-status.sh [--json]
#
# Output: table of customer ID, brand, port, manifest status, gateway status,
#         cost status, backup status
#
# Cost alert defaults (when manifest has no costAlert field):
#   dailyWarning: 15, dailyCritical: 20
#
# Staleness threshold: 48 hours for both cost reports and backups.
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOMERS_DIR="$(dirname "$SCRIPT_DIR")/customers"

# --- Options ---
JSON_OUTPUT=false
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    -h|--help)
      echo "Usage: $0 [--json]"
      echo ""
      echo "Show status of all customer gateway instances."
      echo "  --json   Output as JSON array"
      exit 0
      ;;
  esac
done

# --- Check prerequisites ---
if [[ ! -d "$CUSTOMERS_DIR" ]]; then
  echo "No customers directory found at: $CUSTOMERS_DIR" >&2
  exit 1
fi

HAS_CLI=false
if command -v openclaw &>/dev/null; then
  HAS_CLI=true
fi

# --- Staleness threshold (48 hours in seconds) ---
STALE_THRESHOLD=172800

# --- Collect status ---
declare -a results=()
customer_count=0
active_count=0
running_count=0

for manifest in "$CUSTOMERS_DIR"/*.json; do
  [[ ! -f "$manifest" ]] && continue

  fname="$(basename "$manifest" .json)"
  [[ "$fname" == "example" ]] && continue

  # Read manifest fields in a single node call (also filters templates)
  read -r cid brand port mstatus < <(node -e "
    const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (m.status === 'template') { process.exit(1); }
    console.log([
      m.customerId || '$fname',
      (m.brandName || '?').replace(/\s+/g, '_'),
      m.port || '?',
      m.status || 'unknown'
    ].join(' '));
  " "$manifest" 2>/dev/null) || {
    # exit(1) from template check or parse error — skip
    continue
  }

  customer_count=$((customer_count + 1))

  # Restore spaces in brand name
  brand="${brand//_/ }"

  # Check gateway status
  gw_status="unknown"
  if [[ "$HAS_CLI" == "true" ]] && [[ "$mstatus" != "disabled" ]]; then
    if openclaw --profile "$cid" gateway status --require-rpc &>/dev/null 2>&1; then
      gw_status="running"
      running_count=$((running_count + 1))
    else
      gw_status="stopped"
    fi
  elif [[ "$mstatus" == "disabled" ]]; then
    gw_status="destroyed"
  fi

  if [[ "$mstatus" == "active" ]]; then
    active_count=$((active_count + 1))
  fi

  # Check state dir exists
  state_dir="$HOME/.openclaw-${cid}"
  has_state="no"
  if [[ -d "$state_dir" ]]; then
    has_state="yes"
  fi

  # --- Cost status (single node call for status + coverage) ---
  cost_status="null"
  cost_coverage="null"
  cost_report_file="$state_dir/cost-report-latest.json"
  if [[ -f "$cost_report_file" ]]; then
    read -r cost_status cost_coverage < <(node -e "
      const fs = require('fs');
      const report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
      const staleMs = ${STALE_THRESHOLD} * 1000;

      const generatedAt = new Date(report.generatedAt);
      const ageMs = Date.now() - generatedAt.getTime();

      // Coverage: hours since UTC midnight / 24
      const utcHours = generatedAt.getUTCHours() + generatedAt.getUTCMinutes() / 60;
      const coverage = Math.min(1.0, utcHours / 24).toFixed(2);

      if (ageMs > staleMs) { console.log('STALE ' + coverage); process.exit(0); }

      const warn = manifest.costAlert?.dailyWarning ?? 15;
      const crit = manifest.costAlert?.dailyCritical ?? 20;
      const cost = report.totalCost || 0;

      const status = cost >= crit ? 'CRITICAL' : cost >= warn ? 'WARNING' : 'OK';
      console.log(status + ' ' + coverage);
    " "$cost_report_file" "$manifest" 2>/dev/null) || { cost_status="null"; cost_coverage="null"; }
  fi

  # --- Backup status (single node call for mtime + staleness) ---
  backup_status="null"
  last_backup="null"
  backup_dir="$HOME/.openclaw/backups/customers/${cid}"
  if [[ -d "$backup_dir" ]]; then
    newest_backup=$(find "$backup_dir" -maxdepth 1 -name "*.tar.gz" -type f 2>/dev/null | sort -r | head -1)
    if [[ -n "$newest_backup" ]]; then
      read -r backup_status last_backup < <(node -e "
        const fs = require('fs');
        const stat = fs.statSync(process.argv[1]);
        const mtime = stat.mtime;
        const ageMs = Date.now() - mtime.getTime();
        const status = ageMs > ${STALE_THRESHOLD} * 1000 ? 'STALE' : 'OK';
        console.log(status + ' ' + mtime.toISOString());
      " "$newest_backup" 2>/dev/null) || { backup_status="null"; last_backup="null"; }
    fi
  fi

  results+=("${cid}|${brand}|${port}|${mstatus}|${gw_status}|${has_state}|${cost_status}|${cost_coverage}|${backup_status}|${last_backup}")
done

# --- Handle empty results ---
if [[ ${#results[@]} -eq 0 ]]; then
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    echo "[]"
    exit 0
  fi
  echo ""
  echo -e "${CYAN}═══ Customer Gateway Status ═══${NC}"
  echo ""
  echo -e "${DIM}  No customers found (only example/template manifests present)${NC}"
  echo ""
  echo "  Create a customer manifest in: $CUSTOMERS_DIR/"
  echo "  Then run: bash marketing/scripts/provision-customer.sh create <id>"
  exit 0
fi

# --- Output ---
if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "["
  first=true
  for entry in "${results[@]}"; do
    IFS='|' read -r cid brand port mstatus gw_status has_state cost_status cost_coverage backup_status last_backup <<< "$entry"
    if [[ "$first" == "true" ]]; then
      first=false
    else
      echo ","
    fi
    # Format nullable fields
    cost_status_json="$( [[ "$cost_status" == "null" ]] && echo "null" || echo "\"$cost_status\"" )"
    cost_coverage_json="$( [[ "$cost_coverage" == "null" ]] && echo "null" || echo "$cost_coverage" )"
    backup_status_json="$( [[ "$backup_status" == "null" ]] && echo "null" || echo "\"$backup_status\"" )"
    last_backup_json="$( [[ "$last_backup" == "null" ]] && echo "null" || echo "\"$last_backup\"" )"

    printf '  {"customerId":"%s","brandName":"%s","port":%s,"status":"%s","gateway":"%s","hasState":%s,"costStatus":%s,"costSampleCoverage":%s,"backupStatus":%s,"lastBackup":%s}' \
      "$cid" "$brand" "${port:-null}" "$mstatus" "$gw_status" \
      "$( [[ "$has_state" == "yes" ]] && echo "true" || echo "false" )" \
      "$cost_status_json" "$cost_coverage_json" "$backup_status_json" "$last_backup_json"
  done
  echo ""
  echo "]"
  exit 0
fi

# Table output
echo ""
echo -e "${CYAN}═══ Customer Gateway Status ═══${NC}"
echo ""

# Header
printf "  ${DIM}%-18s %-20s %6s  %-10s %-10s %-8s %-8s %s${NC}\n" \
  "CUSTOMER" "BRAND" "PORT" "MANIFEST" "GATEWAY" "COST" "BACKUP" "STATE"
printf "  ${DIM}%-18s %-20s %6s  %-10s %-10s %-8s %-8s %s${NC}\n" \
  "────────" "─────" "────" "────────" "───────" "────" "──────" "─────"

for entry in "${results[@]}"; do
  IFS='|' read -r cid brand port mstatus gw_status has_state cost_status cost_coverage backup_status last_backup <<< "$entry"

  # Color-code status
  case "$mstatus" in
    active)   ms_color="${GREEN}" ;;
    paused)   ms_color="${YELLOW}" ;;
    disabled) ms_color="${RED}" ;;
    *)        ms_color="${DIM}" ;;
  esac

  case "$gw_status" in
    running)   gw_color="${GREEN}" ;;
    stopped)   gw_color="${RED}" ;;
    destroyed) gw_color="${DIM}" ;;
    *)         gw_color="${DIM}" ;;
  esac

  case "$cost_status" in
    OK)       cost_color="${GREEN}" ;;
    WARNING)  cost_color="${YELLOW}" ;;
    CRITICAL) cost_color="${RED}" ;;
    STALE)    cost_color="${YELLOW}" ;;
    *)        cost_color="${DIM}"; cost_status="--" ;;
  esac

  case "$backup_status" in
    OK)    bk_color="${GREEN}" ;;
    STALE) bk_color="${YELLOW}" ;;
    *)     bk_color="${DIM}"; backup_status="--" ;;
  esac

  state_icon="$( [[ "$has_state" == "yes" ]] && echo "yes" || echo "no" )"

  printf "  %-18s %-20s %6s  ${ms_color}%-10s${NC} ${gw_color}%-10s${NC} ${cost_color}%-8s${NC} ${bk_color}%-8s${NC} %s\n" \
    "$cid" "${brand:0:20}" "$port" "$mstatus" "$gw_status" "$cost_status" "$backup_status" "$state_icon"
done

echo ""
echo -e "${DIM}  Total: $customer_count | Active: $active_count | Running: $running_count${NC}"
echo ""
