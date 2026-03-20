#!/usr/bin/env bash
# ============================================================================
# openclaw CLI shim for testing provision-customer.sh
# ============================================================================
# Simulates openclaw --profile <id> gateway install/start/stop/status/uninstall
# and openclaw --profile <id> channels add/status commands.
# State is tracked per-profile in $SHIM_STATE_DIR/<profile>.state
# ============================================================================

SHIM_STATE_DIR="${OPENCLAW_SHIM_STATE_DIR:-/tmp/openclaw-shim-state}"
mkdir -p "$SHIM_STATE_DIR"

# Parse --profile
PROFILE="default"
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
set -- "${args[@]}"

STATE_FILE="$SHIM_STATE_DIR/${PROFILE}.state"

# Read current state
read_state() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    echo "uninstalled"
  fi
}

write_state() {
  echo "$1" > "$STATE_FILE"
}

# Log the call for test assertions
echo "$(date +%s) $PROFILE $*" >> "$SHIM_STATE_DIR/call.log"

# Route commands
CMD="${1:-}"
SUBCMD="${2:-}"

case "$CMD" in
  gateway)
    case "$SUBCMD" in
      install)
        write_state "installed"
        echo "Installed LaunchAgent: ~/Library/LaunchAgents/ai.openclaw.${PROFILE}.plist"
        # Simulate config overwrite behavior
        CONFIG_PATH="$HOME/.openclaw-${PROFILE}/openclaw.json"
        if [[ -f "$CONFIG_PATH" ]]; then
          # Add gateway token like real CLI does
          node -e "
            const fs = require('fs');
            const c = JSON.parse(fs.readFileSync('$CONFIG_PATH','utf8'));
            if (!c.gateway.auth) c.gateway.auth = {};
            if (!c.gateway.auth.token) c.gateway.auth.token = 'shim-token-${PROFILE}';
            fs.writeFileSync('$CONFIG_PATH', JSON.stringify(c, null, 2));
          " 2>/dev/null
        fi
        exit 0
        ;;
      start)
        local_state="$(read_state)"
        if [[ "$local_state" == "uninstalled" ]]; then
          echo "Error: gateway not installed" >&2
          exit 1
        fi
        write_state "running"
        echo "Restarted LaunchAgent: gui/501/ai.openclaw.${PROFILE}"
        exit 0
        ;;
      stop)
        write_state "stopped"
        exit 0
        ;;
      uninstall)
        write_state "uninstalled"
        exit 0
        ;;
      status)
        local_state="$(read_state)"
        # Check for --require-rpc
        REQUIRE_RPC=false
        for a in "$@"; do
          [[ "$a" == "--require-rpc" ]] && REQUIRE_RPC=true
        done

        if [[ "$local_state" == "running" ]]; then
          echo "Service: LaunchAgent (loaded)"
          echo "Runtime: running (pid 12345, state active)"
          if [[ "$REQUIRE_RPC" == "true" ]]; then
            echo "RPC probe: ok"
          fi
          exit 0
        else
          echo "Service: not running"
          if [[ "$REQUIRE_RPC" == "true" ]]; then
            echo "RPC probe: failed"
          fi
          exit 1
        fi
        ;;
      *)
        echo "Unknown gateway subcommand: $SUBCMD" >&2
        exit 1
        ;;
    esac
    ;;
  channels)
    case "$SUBCMD" in
      add)
        echo "Added channel account"
        exit 0
        ;;
      status)
        echo "Telegram default: enabled, configured, running"
        exit 0
        ;;
      *)
        echo "Unknown channels subcommand: $SUBCMD" >&2
        exit 1
        ;;
    esac
    ;;
  daemon)
    case "$SUBCMD" in
      restart)
        local_state="$(read_state)"
        if [[ "$local_state" != "uninstalled" ]]; then
          write_state "running"
        fi
        echo "Restarted LaunchAgent: gui/501/ai.openclaw.${PROFILE}"
        exit 0
        ;;
      *)
        echo "Unknown daemon subcommand: $SUBCMD" >&2
        exit 1
        ;;
    esac
    ;;
  --version)
    echo "OpenClaw 2026.3.13 (shim)"
    exit 0
    ;;
  approvals)
    echo "Approvals command (shim, no-op)"
    exit 0
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    exit 1
    ;;
esac
