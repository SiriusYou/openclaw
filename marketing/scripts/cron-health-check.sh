#!/usr/bin/env bash
# ============================================================================
# Marketing Agent System — Cron Health Check (Strict)
# ============================================================================
# Authoritative cron health check — T3 references this script exclusively.
# Each job has its own staleness window based on schedule frequency.
# Checks both recency AND last run status (error = FAIL).
#
# Output: JOB_NAME: OK (last run Xh ago) | JOB_NAME: FAIL (reason)
# Exit:   0 = all pass, 1 = any failure
#
# Usage: bash marketing/scripts/cron-health-check.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cron-jobs.conf
source "$SCRIPT_DIR/cron-jobs.conf"

FAILURES=0

# Pre-flight: gateway must be reachable
if ! openclaw gateway probe >/dev/null 2>&1; then
  echo "marketing-gateway-probe: FAIL (gateway unreachable)"
  exit 1
fi

# Fetch cron list once (strip non-JSON prefix from Doctor warnings)
CRON_JSON=$(openclaw cron list --json 2>/dev/null | sed -n '/^{/,$p')

for i in "${!MARKETING_CRON_NAMES[@]}"; do
  JOB_NAME="${MARKETING_CRON_NAMES[$i]}"
  MAX_HOURS="${MARKETING_CRON_WINDOWS[$i]}"

  # Check existence + enabled
  JOB=$(echo "$CRON_JSON" | jq --arg n "$JOB_NAME" '.jobs[] | select(.name==$n)' 2>/dev/null)
  if [ -z "$JOB" ]; then
    echo "${JOB_NAME}: FAIL (job not found)"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  ENABLED=$(echo "$JOB" | jq -r '.enabled')
  if [ "$ENABLED" != "true" ]; then
    echo "${JOB_NAME}: FAIL (job disabled)"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # Check last run within window
  JOB_ID=$(echo "$JOB" | jq -r '.id')
  RUNS_JSON=$(openclaw cron runs --id "$JOB_ID" --limit 1 2>/dev/null | sed -n '/^{/,$p' || true)
  LAST_RUN_TS=$(echo "$RUNS_JSON" | jq -r '.entries[0].ts // empty' 2>/dev/null || true)

  if [ -z "$LAST_RUN_TS" ]; then
    echo "${JOB_NAME}: FAIL (no runs found)"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  NOW_MS=$(($(date +%s) * 1000))
  AGE_HOURS=$(( (NOW_MS - LAST_RUN_TS) / 3600000 ))
  LAST_STATUS=$(echo "$RUNS_JSON" | jq -r '.entries[0].status // "unknown"' 2>/dev/null || echo "unknown")

  # Check status first — error is a failure regardless of recency
  if [ "$LAST_STATUS" != "ok" ]; then
    echo "${JOB_NAME}: FAIL (last run ${AGE_HOURS}h ago, status: ${LAST_STATUS})"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # Check recency
  if [ "$AGE_HOURS" -le "$MAX_HOURS" ]; then
    echo "${JOB_NAME}: OK (last run ${AGE_HOURS}h ago)"
  else
    echo "${JOB_NAME}: FAIL (last run ${AGE_HOURS}h ago, exceeds ${MAX_HOURS}h window)"
    FAILURES=$((FAILURES + 1))
  fi
done

# Summary
echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "HEALTH CHECK FAILED (${FAILURES} job(s) unhealthy)"
  exit 1
else
  echo "HEALTH CHECK PASSED (${MARKETING_CRON_COUNT}/${MARKETING_CRON_COUNT} healthy)"
  exit 0
fi
