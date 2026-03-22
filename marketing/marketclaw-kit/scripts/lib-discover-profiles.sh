#!/usr/bin/env bash
# ============================================================================
# lib-discover-profiles.sh — Shared Customer Profile Discovery
# ============================================================================
#
# Discovery predicate (shared across M6 scripts):
#   - Directory matches ~/.openclaw-{id}
#   - Contains openclaw.json
#   - Excludes .openclaw-archives
#
# Usage: source "$(dirname "$0")/lib-discover-profiles.sh"
#        profiles=($(discover_profiles))
# ============================================================================

discover_profiles() {
  local profiles=()
  for dir in "$HOME"/.openclaw-*/; do
    [[ ! -d "$dir" ]] && continue
    local base
    base="$(basename "$dir")"
    [[ "$base" == ".openclaw-archives" ]] && continue
    [[ ! -f "$dir/openclaw.json" ]] && continue
    local id="${base#.openclaw-}"
    profiles+=("$id")
  done
  echo "${profiles[@]}"
}
