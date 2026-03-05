#!/usr/bin/env bash
# ============================================================================
# OpenClaw Marketing — Daily Backup (Git-tracked Template)
# ============================================================================
# Creates date-stamped snapshots of critical config and workspace files.
# Deployed to ~/.openclaw/scripts/daily-backup.sh by setup.sh.
# Scheduled via launchd (com.openclaw.daily-backup) at 3:00 AM.
#
# Usage: bash daily-backup.sh [--dry-run]
#
# Backup scope:
#   - ~/.openclaw/openclaw.json (runtime config)
#   - ~/.openclaw/agents/*/agent/auth-profiles.json (auth credentials)
#   - ~/.openclaw/workspaces/marketing/skills/evolved/ (agent-created skills)
#   - ~/.openclaw/workspaces/marketing/memory/ (agent memory)
#
# Retention: 30 days (date-based directory snapshots)
# ============================================================================

set -euo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
BACKUP_BASE="$OPENCLAW_DIR/backups"
TODAY=$(date +%Y-%m-%d)
BACKUP_DIR="$BACKUP_BASE/$TODAY"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== Daily Backup ==="
log "  Source: $OPENCLAW_DIR"
log "  Target: $BACKUP_DIR"
log "  Dry run: $DRY_RUN"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "Files that would be backed up:"
  echo "  openclaw.json"
  echo "  agents/*/agent/auth-profiles.json"
  echo "  workspaces/marketing/skills/evolved/"
  echo "  workspaces/marketing/memory/"
  echo ""
  echo "Run without --dry-run to execute."
  exit 0
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

# 1. Runtime config
if [ -f "$OPENCLAW_DIR/openclaw.json" ]; then
  cp "$OPENCLAW_DIR/openclaw.json" "$BACKUP_DIR/openclaw.json"
  log "  Backed up: openclaw.json"
fi

# 2. Auth profiles (preserve directory structure)
for auth_file in "$OPENCLAW_DIR"/agents/*/agent/auth-profiles.json; do
  if [ -f "$auth_file" ]; then
    # Extract relative path: agents/<id>/agent/auth-profiles.json
    rel_path="${auth_file#$OPENCLAW_DIR/}"
    mkdir -p "$BACKUP_DIR/$(dirname "$rel_path")"
    cp "$auth_file" "$BACKUP_DIR/$rel_path"
    log "  Backed up: $rel_path"
  fi
done

# 3. Evolved skills
EVOLVED_SRC="$OPENCLAW_DIR/workspaces/marketing/skills/evolved"
if [ -d "$EVOLVED_SRC" ]; then
  EVOLVED_DST="$BACKUP_DIR/workspaces/marketing/skills/evolved"
  mkdir -p "$EVOLVED_DST"
  rsync -a --exclude='.git' "$EVOLVED_SRC/" "$EVOLVED_DST/"
  log "  Backed up: workspaces/marketing/skills/evolved/"
fi

# 4. Marketing memory
MEMORY_SRC="$OPENCLAW_DIR/workspaces/marketing/memory"
if [ -d "$MEMORY_SRC" ]; then
  MEMORY_DST="$BACKUP_DIR/workspaces/marketing/memory"
  mkdir -p "$MEMORY_DST"
  rsync -a "$MEMORY_SRC/" "$MEMORY_DST/"
  log "  Backed up: workspaces/marketing/memory/"
fi

# 5. Cleanup old backups (>30 days)
CLEANED=$(find "$BACKUP_BASE" -maxdepth 1 -type d -name "20*" -mtime +30 2>/dev/null | wc -l | tr -d ' ')
if [ "$CLEANED" -gt 0 ]; then
  find "$BACKUP_BASE" -maxdepth 1 -type d -name "20*" -mtime +30 -exec rm -rf {} +
  log "  Cleaned up $CLEANED backup(s) older than 30 days"
fi

log "=== Backup Complete ==="
