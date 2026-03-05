#!/usr/bin/env bash
# ============================================================================
# Marketing Agent System — Cron Smoke Test
# ============================================================================
# Checks: 5 marketing cron jobs exist, enabled, and have recent runs.
#
# Usage: bash marketing/scripts/cron-smoke.sh [--recent-hours 48]
# ============================================================================

set -euo pipefail

RECENT_HOURS="${1:-48}"
PASS=0
FAIL=0
WARN=0

pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }
warn() { echo "  WARN: $*"; WARN=$((WARN + 1)); }

echo "=== Marketing Cron Smoke Test ==="
echo "  Recent window: ${RECENT_HOURS}h"
echo ""

# Fetch cron list once
CRON_JSON=$(openclaw cron list --json 2>&1)

EXPECTED_CRONS=(
  "marketing-cost-daily"
  "marketing-brief-daily"
  "marketing-reflect-weekly"
  "marketing-evolution-semimonthly"
  "marketing-gateway-health"
)

for CRON_NAME in "${EXPECTED_CRONS[@]}"; do
  echo "[$CRON_NAME]"

  # Check existence
  JOB=$(echo "$CRON_JSON" | jq --arg n "$CRON_NAME" '.jobs[] | select(.name==$n)' 2>/dev/null)
  if [ -z "$JOB" ]; then
    fail "Job not found"
    continue
  fi
  pass "Job exists"

  # Check enabled
  ENABLED=$(echo "$JOB" | jq -r '.enabled')
  if [ "$ENABLED" = "true" ]; then
    pass "Enabled"
  else
    fail "Disabled"
  fi

  # Check recent runs
  JOB_ID=$(echo "$JOB" | jq -r '.id')
  RUNS_JSON=$(openclaw cron runs --id "$JOB_ID" --limit 1 2>&1 || true)
  LAST_RUN_TS=$(echo "$RUNS_JSON" | jq -r '.entries[0].ts // empty' 2>/dev/null || true)

  if [ -n "$LAST_RUN_TS" ]; then
    NOW_MS=$(($(date +%s) * 1000))
    AGE_HOURS=$(( (NOW_MS - LAST_RUN_TS) / 3600000 ))
    LAST_STATUS=$(echo "$RUNS_JSON" | jq -r '.entries[0].status // "unknown"' 2>/dev/null || echo "unknown")

    if [ "$AGE_HOURS" -le "$RECENT_HOURS" ]; then
      pass "Last run: ${AGE_HOURS}h ago (status: $LAST_STATUS)"
    else
      warn "Last run: ${AGE_HOURS}h ago (older than ${RECENT_HOURS}h window)"
    fi
  else
    warn "No runs found"
  fi

  echo ""
done

# --- Summary ---
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "CRON SMOKE TEST FAILED ($FAIL failures)"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "CRON SMOKE TEST PASSED with warnings"
  exit 0
else
  echo "CRON SMOKE TEST PASSED"
  exit 0
fi
