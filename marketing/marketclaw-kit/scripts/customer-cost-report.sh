#!/usr/bin/env bash
# ============================================================================
# customer-cost-report.sh — Cross-Profile Cost Aggregation
# ============================================================================
#
# Discovers customer profiles via ~/.openclaw-*/, queries cost per profile
# using `openclaw --profile {id} gateway usage-cost --days 1 --json`, and writes
# per-profile cost-report-latest.json.
#
# Usage:
#   bash scripts/customer-cost-report.sh [--dry-run]
#
# Output per profile:
#   ~/.openclaw-{id}/cost-report-latest.json
#   {
#     "date": "YYYY-MM-DD",
#     "generatedAt": "ISO8601 timestamp",
#     "window": "1d",
#     "totalCost": N,
#     "input": N,
#     "output": N
#   }
#
# Also prints a human-readable summary table to stdout.
#
# Scheduling: com.openclaw.cost-report.plist runs this at local 23:45.
# For CST (UTC+8), this captures ~65% of the UTC day (UTC 00:00-15:45).
# Cost alerts based on this data are trend signals, not precise daily totals.
#
# Discovery predicate (shared with backup-all-customers.sh, security-check.sh):
#   - Directory matches ~/.openclaw-{id}
#   - Contains openclaw.json
#   - Excludes .openclaw-archives
# ============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# --- Discovery (shared predicate) ---
# shellcheck source=lib-discover-profiles.sh
source "$(dirname "$0")/lib-discover-profiles.sh"

# --- Main ---
log "=== Customer Cost Report ==="

profiles=($(discover_profiles))
if [[ ${#profiles[@]} -eq 0 ]]; then
  log "No customer profiles discovered."
  exit 0
fi

log "Discovered ${#profiles[@]} profile(s): ${profiles[*]}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "Profiles that would be queried:"
  for p in "${profiles[@]}"; do
    echo "  - $p (~/.openclaw-${p}/cost-report-latest.json)"
  done
  echo ""
  echo "Run without --dry-run to execute."
  exit 0
fi

TODAY=$(date -u +%Y-%m-%d)
GENERATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Table header
echo ""
printf "  ${DIM}%-18s %10s %12s %12s %8s${NC}\n" "PROFILE" "COST" "INPUT_TOK" "OUTPUT_TOK" "STATUS"
printf "  ${DIM}%-18s %10s %12s %12s %8s${NC}\n" "────────" "────" "─────────" "──────────" "──────"

success_count=0
fail_count=0

for id in "${profiles[@]}"; do
  state_dir="$HOME/.openclaw-${id}"
  report_file="$state_dir/cost-report-latest.json"

  # Query cost via usage-cost subcommand (--json for machine-readable output)
  # --days 1 returns current UTC day: todayStartMs..now
  cost_json=""
  if cost_json=$(openclaw --profile "$id" gateway usage-cost --days 1 --json 2>/dev/null); then
    # Parse cost data and write report in a single node call.
    # Field names match CostUsageTotals: totals.totalCost, totals.input, totals.output
    # (src/infra/session-cost-usage.ts)
    read -r total_cost input_tok output_tok < <(node -e "
      const data = JSON.parse(process.argv[1]);
      const totals = data.totals || {};
      const cost = totals.totalCost || 0;
      const input = totals.input || 0;
      const output = totals.output || 0;
      const report = {
        date: process.argv[2],
        generatedAt: process.argv[3],
        window: '1d',
        totalCost: cost,
        input: input,
        output: output
      };
      require('fs').writeFileSync(process.argv[4], JSON.stringify(report, null, 2) + '\n');
      console.log(cost + ' ' + input + ' ' + output);
    " "$cost_json" "$TODAY" "$GENERATED_AT" "$report_file" 2>/dev/null) || {
      total_cost=0; input_tok=0; output_tok=0
    }

    printf "  %-18s %10s %12s %12s ${GREEN}%8s${NC}\n" \
      "$id" "\$${total_cost}" "$input_tok" "$output_tok" "OK"
    success_count=$((success_count + 1))
  else
    printf "  %-18s %10s %12s %12s ${RED}%8s${NC}\n" \
      "$id" "--" "--" "--" "FAIL"
    fail_count=$((fail_count + 1))
  fi
done

echo ""
log "Done: ${success_count} succeeded, ${fail_count} failed"
