#!/usr/bin/env bash
# ============================================================================
# OpenClaw CLI + Gateway Upgrade
# ============================================================================
# Upgrades the CLI npm package and restarts the launchd gateway daemon.
#
# Usage: bash marketing/scripts/upgrade-cli.sh [version]
#   version: npm version to install (default: "latest")
#
# Examples:
#   bash marketing/scripts/upgrade-cli.sh           # upgrade to latest
#   bash marketing/scripts/upgrade-cli.sh 2026.3.2  # pin specific version
# ============================================================================

set -euo pipefail

TARGET="${1:-latest}"
OLD_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")

echo "=== OpenClaw CLI Upgrade ==="
echo "  Current: $OLD_VERSION"
echo "  Target:  $TARGET"
echo ""

# Step 1: Upgrade CLI
echo "[1/3] Installing openclaw@${TARGET}..."
npm i -g "openclaw@${TARGET}" 2>&1 | tail -3

NEW_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
echo "  Installed: $NEW_VERSION"
echo ""

if [ "$OLD_VERSION" = "$NEW_VERSION" ] && [ "$TARGET" = "latest" ]; then
  echo "Already on latest version ($NEW_VERSION). No daemon restart needed."
  exit 0
fi

# Step 2: Update launchd plist
echo "[2/3] Updating launchd plist..."
openclaw daemon install --force --runtime node 2>&1 | grep -v "Doctor warnings" | grep -v "groupPolicy" | grep -v "allowFrom" | grep -v "^│" | grep -v "^├" | grep -v "^◇" | grep -v "^$" || true
echo ""

# Step 3: Restart daemon
echo "[3/3] Restarting gateway daemon..."
openclaw daemon restart 2>&1 | grep -v "Doctor warnings" | grep -v "groupPolicy" | grep -v "allowFrom" | grep -v "^│" | grep -v "^├" | grep -v "^◇" | grep -v "^$" || true
echo ""

# Verify
sleep 3
echo "=== Verification ==="
PROBE=$(openclaw gateway probe 2>&1 || true)
if echo "$PROBE" | grep -q "Reachable: yes"; then
  echo "  CLI version: $NEW_VERSION"
  echo "  Gateway: reachable"
  echo ""
  echo "UPGRADE SUCCESS"
else
  echo "  CLI version: $NEW_VERSION"
  echo "  Gateway: NOT reachable"
  echo ""
  echo "UPGRADE WARNING: Gateway may need more time to start."
  echo "  Check: openclaw gateway probe"
  echo "  Logs:  tail ~/.openclaw/logs/gateway.log"
  exit 1
fi
