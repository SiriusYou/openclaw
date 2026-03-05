#!/usr/bin/env bash
# sync-runtime-config.sh — Convert JSON5 source config to JSON runtime config
#
# Resolves __WORKSPACE_ROOT__ placeholders and converts JSON5 → standard JSON.
# Deep-merges source into existing runtime config, preserving runtime-only
# fields (channels, commands, meta) added by CLI commands.
#
# Usage:
#   ./sync-runtime-config.sh [--restart] [--dry-run]
#
# Options:
#   --restart   Restart gateway after syncing
#   --dry-run   Show diff without applying changes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKETING_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE_CONFIG="$MARKETING_DIR/openclaw.json"
RUNTIME_CONFIG="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
WORKSPACES_DIR="${OPENCLAW_HOME:-$HOME/.openclaw}/workspaces"

RESTART=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      echo "Usage: $0 [--restart] [--dry-run]"
      echo ""
      echo "Sync source config (JSON5) → runtime config (JSON)."
      echo "  --restart   Restart gateway after sync"
      echo "  --dry-run   Show diff without applying"
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# --- Validate prerequisites ---

if [ ! -f "$SOURCE_CONFIG" ]; then
  echo "Error: Source config not found: $SOURCE_CONFIG" >&2
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "Error: node is required for JSON5 → JSON conversion" >&2
  exit 1
fi

# --- Convert JSON5 → JSON with placeholder resolution ---
# Uses node to strip JSON5 features (comments, unquoted keys, trailing commas)
# via regex, then JSON.parse for safe parsing. No eval/Function.

CONVERTED=$(node -e "
  const fs = require('fs');
  let raw = fs.readFileSync(process.argv[1], 'utf8');
  raw = raw.replace(/__WORKSPACE_ROOT__/g, process.argv[2]);
  // Strip // comments while preserving // inside quoted strings (e.g. URLs)
  raw = raw.split('\n').map(line => {
    let inString = false, escaped = false, result = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) { escaped = false; result += ch; continue; }
      if (ch === '\\\\') { escaped = true; result += ch; continue; }
      if (ch === '\"') { inString = !inString; result += ch; continue; }
      if (!inString && ch === '/' && line[i+1] === '/') break;
      result += ch;
    }
    return result;
  }).join('\n');
  // Quote unquoted keys: word followed by :
  raw = raw.replace(/(?<=^|[{,\n])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm, ' \"\$1\":');
  // Remove trailing commas before } or ]
  raw = raw.replace(/,(\s*[}\]])/g, '\$1');
  try {
    const obj = JSON.parse(raw);
    process.stdout.write(JSON.stringify(obj, null, 2));
  } catch (e) {
    process.stderr.write('JSON parse error: ' + e.message + '\n');
    process.stderr.write('Near: ' + raw.substring(0, 200) + '\n');
    process.exit(1);
  }
" "$SOURCE_CONFIG" "$WORKSPACES_DIR")

# --- Deep-merge source into existing runtime config ---
# Source keys override runtime keys. Runtime-only keys (channels, commands,
# meta) are preserved. This prevents destroying fields added by CLI commands
# like `openclaw channels add` or `openclaw plugins enable`.

if [ -f "$RUNTIME_CONFIG" ]; then
  MERGED=$(node -e "
    const fs = require('fs');
    const source = JSON.parse(process.argv[1]);
    const runtime = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

    function deepMerge(base, overlay) {
      const result = { ...base };
      for (const key of Object.keys(overlay)) {
        if (
          overlay[key] && typeof overlay[key] === 'object' && !Array.isArray(overlay[key]) &&
          result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
        ) {
          result[key] = deepMerge(result[key], overlay[key]);
        } else {
          result[key] = overlay[key];
        }
      }
      return result;
    }

    const merged = deepMerge(runtime, source);
    process.stdout.write(JSON.stringify(merged, null, 2) + '\n');
  " "$CONVERTED" "$RUNTIME_CONFIG")
else
  MERGED="$CONVERTED"
fi

# --- Show diff ---

if [ -f "$RUNTIME_CONFIG" ]; then
  # Sort keys deeply to avoid false diffs from JSON key ordering
  SORT_JSON='const fs=require("fs"); function sortDeep(o){if(Array.isArray(o))return o.map(sortDeep);if(o&&typeof o==="object"){const s={};Object.keys(o).sort().forEach(k=>{s[k]=sortDeep(o[k])});return s}return o} const d=JSON.parse(fs.readFileSync("/dev/stdin","utf8")); process.stdout.write(JSON.stringify(sortDeep(d),null,2)+"\n");'
  DIFF=$(diff --unified=3 \
    <(node -e "$SORT_JSON" < "$RUNTIME_CONFIG") \
    <(echo "$MERGED" | node -e "$SORT_JSON") \
    || true)
  if [ -z "$DIFF" ]; then
    echo "No changes — runtime config is already in sync."
    if [ "$RESTART" = true ] && [ "$DRY_RUN" = false ]; then
      echo "Restarting gateway (--restart flag)..."
      openclaw gateway restart 2>&1 || echo "Warning: gateway restart failed"
    fi
    exit 0
  fi
  echo "Changes to apply:"
  echo "$DIFF"
else
  echo "Runtime config does not exist yet. Will create: $RUNTIME_CONFIG"
fi

# --- Apply or dry-run ---

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "(dry-run mode — no changes applied)"
  exit 0
fi

echo "$MERGED" > "$RUNTIME_CONFIG"
echo "Synced: $SOURCE_CONFIG → $RUNTIME_CONFIG"

if [ "$RESTART" = true ]; then
  echo "Restarting gateway..."
  openclaw gateway restart 2>&1 || echo "Warning: gateway restart failed"
fi
