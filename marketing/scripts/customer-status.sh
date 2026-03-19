#!/usr/bin/env bash
# ============================================================================
# customer-status.sh — Multi-Customer Gateway Status Aggregator
# ============================================================================
#
# Iterates all customer manifests and reports gateway status for each.
#
# Usage:
#   ./customer-status.sh [--json]
#
# Output: table of customer ID, brand, port, manifest status, gateway status
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

  # Restore spaces in brand name
  brand="${brand//_/ }"

  # Check gateway status
  gw_status="unknown"
  if [[ "$HAS_CLI" == "true" ]] && [[ "$mstatus" != "disabled" ]]; then
    if openclaw --profile "$cid" gateway status &>/dev/null 2>&1; then
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

  results+=("${cid}|${brand}|${port}|${mstatus}|${gw_status}|${has_state}")
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
    IFS='|' read -r cid brand port mstatus gw_status has_state <<< "$entry"
    if [[ "$first" == "true" ]]; then
      first=false
    else
      echo ","
    fi
    printf '  {"customerId":"%s","brandName":"%s","port":%s,"status":"%s","gateway":"%s","hasState":%s}' \
      "$cid" "$brand" "${port:-null}" "$mstatus" "$gw_status" \
      "$( [[ "$has_state" == "yes" ]] && echo "true" || echo "false" )"
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
printf "  ${DIM}%-18s %-20s %6s  %-10s %-10s %s${NC}\n" \
  "CUSTOMER" "BRAND" "PORT" "MANIFEST" "GATEWAY" "STATE"
printf "  ${DIM}%-18s %-20s %6s  %-10s %-10s %s${NC}\n" \
  "────────" "─────" "────" "────────" "───────" "─────"

for entry in "${results[@]}"; do
  IFS='|' read -r cid brand port mstatus gw_status has_state <<< "$entry"

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

  state_icon="$( [[ "$has_state" == "yes" ]] && echo "yes" || echo "no" )"

  printf "  %-18s %-20s %6s  ${ms_color}%-10s${NC} ${gw_color}%-10s${NC} %s\n" \
    "$cid" "${brand:0:20}" "$port" "$mstatus" "$gw_status" "$state_icon"
done

echo ""
echo -e "${DIM}  Total: $customer_count | Active: $active_count | Running: $running_count${NC}"
echo ""
