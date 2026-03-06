# Failover Drill Log

Record each failover drill to track recovery readiness.

## Drill Trigger Conditions

A live drill SHOULD be performed when:

- Gateway has been offline for >1 hour unexpectedly
- Auth profile rotation (provider key change)
- After major upstream sync (>100 commits)
- Quarterly (minimum frequency)

## Log Format

| Date         | Trigger  | Scenario          | Result      | Recovery Time | Notes     |
| ------------ | -------- | ----------------- | ----------- | ------------- | --------- |
| _YYYY-MM-DD_ | _reason_ | _what was tested_ | _pass/fail_ | _Xm_          | _details_ |

## Drill History

| Date       | Trigger      | Scenario                 | Result  | Recovery Time | Notes                                                                                                                    |
| ---------- | ------------ | ------------------------ | ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-03-05 | Tech debt B2 | Config restore (dry-run) | PARTIAL | N/A           | Backup only has pre-phase-c snapshot (stale JSON5). Runtime openclaw.json has no current backup. Restore would be lossy. |
| 2026-03-05 | Tech debt B2 | Auth recovery (dry-run)  | FAIL    | N/A           | auth-profiles.json NOT in backup at all. Recovery requires re-creating all API keys + OAuth tokens.                      |
| 2026-03-05 | Tech debt B2 | Skill recovery (dry-run) | PASS    | <1m           | Evolved skills backed up via git-based backup. 5 evolved skills present in latest commit.                                |

### 2026-03-05 Drill Notes

**Gaps identified:**

1. Deployed backup script (`~/.openclaw/scripts/daily-backup.sh`) is the old git-based version that only backs up workspace content
2. Repo template (`marketing/scripts/daily-backup.sh`) already includes `openclaw.json` + `auth-profiles.json` backup — but was never redeployed
3. Workspace content (skills, memory, strategies) fully covered by both old and new scripts ✅

**Recommended fix:** Redeploy repo template to `~/.openclaw/scripts/daily-backup.sh` and verify next backup creates date-based snapshot with config + auth files

## Scenarios to Drill

1. **Config restore**: Restore `openclaw.json` from backup snapshot, restart gateway
2. **Auth recovery**: Restore `auth-profiles.json`, verify model connectivity
3. **Skill recovery**: Restore evolved skills from backup, verify skill list
4. **Full recovery**: Restore all 4 backup items, restart, run acceptance-smoke.sh
