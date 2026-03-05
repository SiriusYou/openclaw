#!/usr/bin/env bash
# ============================================================================
# Marketing Agent System — Acceptance Smoke Test
# ============================================================================
# Covers: T1 (gateway), T2 (skill write), T5 (5 cron jobs), T8 (config)
# Dangerous actions (cron trigger, Telegram delivery) require manual confirmation.
#
# Usage: bash marketing/scripts/acceptance-smoke.sh
# ============================================================================

set -euo pipefail

PASS=0
FAIL=0
SKIP=0

pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $*"; SKIP=$((SKIP + 1)); }

echo "=== Marketing Acceptance Smoke Test ==="
echo ""

# --- T1: Gateway Reachable ---
echo "[T1] Gateway health"
if openclaw gateway probe >/dev/null 2>&1; then
  pass "Gateway is reachable"
else
  fail "Gateway unreachable — start the OpenClaw Mac App"
fi

# --- T1: Telegram channel connected ---
echo "[T1] Telegram channel"
TELEGRAM_STATUS=$(openclaw channels status --probe 2>&1 || true)
if echo "$TELEGRAM_STATUS" | grep -q "running"; then
  pass "Telegram channel is running"
else
  fail "Telegram channel not running"
fi

# --- T2: Evolved skills directory writable ---
echo "[T2] Evolved skills directory"
EVOLVED_DIR="$HOME/.openclaw/workspaces/marketing/skills/evolved"
if [ -d "$EVOLVED_DIR" ]; then
  TESTFILE="$EVOLVED_DIR/.smoke-test-$(date +%s)"
  if touch "$TESTFILE" 2>/dev/null; then
    rm -f "$TESTFILE"
    pass "Evolved skills directory is writable"
  else
    fail "Evolved skills directory exists but not writable"
  fi
else
  fail "Evolved skills directory not found: $EVOLVED_DIR"
fi

# --- T2: Skill-audit plugin loaded ---
echo "[T2] Skill-audit plugin"
PLUGIN_LIST=$(openclaw plugins list 2>&1 || true)
if echo "$PLUGIN_LIST" | grep -q "skill-audit"; then
  pass "skill-audit plugin is registered"
else
  fail "skill-audit plugin not found in plugin list"
fi

# --- T5: 4 marketing cron jobs exist and enabled ---
echo "[T5] Marketing cron jobs"
CRON_JSON=$(openclaw cron list --json 2>&1 || true)
MARKETING_COUNT=$(echo "$CRON_JSON" | jq '[.jobs[] | select(.name | startswith("marketing-")) | select(.enabled==true)] | length' 2>/dev/null || echo "0")
if [ "$MARKETING_COUNT" -eq 5 ]; then
  pass "5 marketing cron jobs enabled"
else
  fail "Expected 5 marketing crons, got $MARKETING_COUNT"
fi

# --- T5: Each cron job by name ---
for CRON_NAME in marketing-cost-daily marketing-brief-daily marketing-reflect-weekly marketing-evolution-semimonthly marketing-gateway-health; do
  EXISTS=$(echo "$CRON_JSON" | jq --arg n "$CRON_NAME" '[.jobs[] | select(.name==$n)] | length' 2>/dev/null || echo "0")
  if [ "$EXISTS" -ge 1 ]; then
    pass "Cron job exists: $CRON_NAME"
  else
    fail "Cron job missing: $CRON_NAME"
  fi
done

# --- T8: Runtime config exists ---
echo "[T8] Runtime configuration"
RUNTIME_CONFIG="$HOME/.openclaw/openclaw.json"
if [ -f "$RUNTIME_CONFIG" ]; then
  pass "Runtime config exists: $RUNTIME_CONFIG"
else
  fail "Runtime config missing: $RUNTIME_CONFIG"
fi

# --- T8: Auth profiles exist ---
AUTH_PROFILES="$HOME/.openclaw/agents/main/agent/auth-profiles.json"
if [ -f "$AUTH_PROFILES" ]; then
  pass "Auth profiles exist"
else
  fail "Auth profiles missing: $AUTH_PROFILES"
fi

# --- T8: sendPolicy configured ---
SEND_POLICY=$(jq '.session.sendPolicy // .sendPolicy' "$RUNTIME_CONFIG" 2>/dev/null || echo "null")
if [ "$SEND_POLICY" != "null" ]; then
  pass "sendPolicy is configured"
else
  fail "sendPolicy not found in runtime config"
fi

# --- Summary ---
echo ""
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "SMOKE TEST FAILED ($FAIL failures)"
  exit 1
else
  echo "SMOKE TEST PASSED"
  exit 0
fi
