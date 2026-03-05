#!/usr/bin/env bash
# ============================================================================
# OpenClaw Marketing — Log Rotation
# ============================================================================
# Cleans up logs older than 14 days from /tmp/openclaw/
#
# Usage: bash marketing/scripts/log-rotate.sh [--dry-run]
# Recommended: run weekly via launchd or cron
# ============================================================================

set -euo pipefail

LOG_DIR="/tmp/openclaw"
RETENTION_DAYS=14
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [ ! -d "$LOG_DIR" ]; then
  echo "Log directory not found: $LOG_DIR"
  exit 0
fi

echo "=== Log Rotation ==="
echo "  Directory: $LOG_DIR"
echo "  Retention: ${RETENTION_DAYS} days"
echo "  Dry run:   $DRY_RUN"
echo ""

# Find log files older than retention period
OLD_FILES=$(find "$LOG_DIR" -type f -name "*.log" -mtime +${RETENTION_DAYS} 2>/dev/null || true)

if [ -z "$OLD_FILES" ]; then
  echo "No logs older than ${RETENTION_DAYS} days found."
  exit 0
fi

COUNT=$(echo "$OLD_FILES" | wc -l | tr -d ' ')
SIZE=$(echo "$OLD_FILES" | xargs du -ch 2>/dev/null | tail -1 | cut -f1)

echo "Found $COUNT log file(s) to clean ($SIZE total)"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "Files that would be deleted:"
  echo "$OLD_FILES" | while read -r f; do
    echo "  $f ($(stat -f '%Sm' -t '%Y-%m-%d' "$f" 2>/dev/null || date -r "$f" +%Y-%m-%d 2>/dev/null || echo '?'))"
  done
  echo ""
  echo "Run without --dry-run to delete."
else
  echo "$OLD_FILES" | xargs rm -f
  echo "Deleted $COUNT log file(s)."
fi
