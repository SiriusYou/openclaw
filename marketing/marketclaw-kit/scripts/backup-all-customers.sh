#!/usr/bin/env bash
# ============================================================================
# backup-all-customers.sh — Per-Profile Customer Backup
# ============================================================================
#
# Discovers customer profiles via ~/.openclaw-*/ and creates whole-directory
# tar archives for each. Also copies cron/jobs.json as a quick-reference file.
#
# Usage:
#   bash scripts/backup-all-customers.sh [--dry-run]
#
# Backup layout:
#   ~/.openclaw/backups/customers/{id}/YYYY-MM-DD.tar.gz
#
# Retention: 30 days (date-based archives)
#
# Scheduling: com.openclaw.backup-all-customers.plist runs this at 3:30 AM.
#
# Discovery predicate (shared with customer-cost-report.sh, security-check.sh):
#   - Directory matches ~/.openclaw-{id}
#   - Contains openclaw.json
#   - Excludes .openclaw-archives
# ============================================================================

set -euo pipefail

BACKUP_BASE="$HOME/.openclaw/backups/customers"
TODAY=$(date +%Y-%m-%d)
DRY_RUN=false
RETENTION_DAYS=30

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# --- Discovery (shared predicate) ---
# shellcheck source=lib-discover-profiles.sh
source "$(dirname "$0")/lib-discover-profiles.sh"

# --- Main ---
log "=== Customer Backup (All Profiles) ==="

profiles=($(discover_profiles))
if [[ ${#profiles[@]} -eq 0 ]]; then
  log "No customer profiles discovered."
  exit 0
fi

log "Discovered ${#profiles[@]} profile(s): ${profiles[*]}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "Profiles that would be backed up:"
  for p in "${profiles[@]}"; do
    local_dir="$HOME/.openclaw-${p}"
    echo "  - $p ($local_dir → $BACKUP_BASE/$p/$TODAY.tar.gz)"
  done
  echo ""
  echo "Run without --dry-run to execute."
  exit 0
fi

success_count=0
fail_count=0

for id in "${profiles[@]}"; do
  state_dir="$HOME/.openclaw-${id}"
  backup_dir="$BACKUP_BASE/$id"
  archive="$backup_dir/$TODAY.tar.gz"

  mkdir -p "$backup_dir"

  # Whole-directory tar (consistent with provision-customer.sh export)
  if tar -czf "$archive" \
    -C "$(dirname "$state_dir")" \
    "$(basename "$state_dir")" 2>/dev/null; then
    size=$(du -h "$archive" | cut -f1)
    log "  Backed up $id → $archive ($size)"

    # Copy cron/jobs.json as quick-reference (if exists)
    cron_file="$state_dir/cron/jobs.json"
    if [[ -f "$cron_file" ]]; then
      cp "$cron_file" "$backup_dir/jobs-$TODAY.json"
    fi

    success_count=$((success_count + 1))
  else
    log "  FAILED to backup $id"
    fail_count=$((fail_count + 1))
  fi
done

# --- Cleanup old backups (>30 days) ---
cleaned=0
for id_dir in "$BACKUP_BASE"/*/; do
  [[ ! -d "$id_dir" ]] && continue
  old_files=$(find "$id_dir" -maxdepth 1 -name "*.tar.gz" -mtime +${RETENTION_DAYS} 2>/dev/null || true)
  if [[ -n "$old_files" ]]; then
    count=$(echo "$old_files" | wc -l | tr -d ' ')
    echo "$old_files" | xargs rm -f
    # Also remove corresponding jobs-*.json
    find "$id_dir" -maxdepth 1 -name "jobs-*.json" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
    cleaned=$((cleaned + count))
  fi
done

if [[ $cleaned -gt 0 ]]; then
  log "  Cleaned up $cleaned archive(s) older than ${RETENTION_DAYS} days"
fi

log "=== Backup Complete: ${success_count} succeeded, ${fail_count} failed ==="
