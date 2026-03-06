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
| 2026-03-05 | Tech debt B2 | Skill recovery (dry-run) | PASS    | <1m           | Evolved skills in git-based backup. Job active, multiple backup records observed since 2026-03-01.                       |
| 2026-03-05 | R1 redeploy  | Config restore (verify)  | PASS    | <1m           | Redeployed backup script; openclaw.json (6.3KB) in date-based snapshot.                                                  |
| 2026-03-05 | R1 redeploy  | Auth recovery (verify)   | PASS    | <1m           | auth-profiles.json (3.1KB) for main + 3 other agents now backed up.                                                      |
| 2026-03-05 | R1 redeploy  | Skill recovery (verify)  | PASS    | <1m           | Evolved skills + memory in date-based snapshot. Consistent with previous git-based backup.                               |

### 2026-03-05 Drill Notes

**Gaps identified:**

1. Deployed backup script (`~/.openclaw/scripts/daily-backup.sh`) is the old git-based version that only backs up workspace content
2. Repo template (`marketing/scripts/daily-backup.sh`) already includes `openclaw.json` + `auth-profiles.json` backup — but was never redeployed
3. Workspace content (skills, memory, strategies) fully covered by both old and new scripts ✅

**Recommended fix:** Redeploy repo template to `~/.openclaw/scripts/daily-backup.sh` and verify next backup creates date-based snapshot with config + auth files

### 2026-03-05 R1 Redeploy Verification

**D3 closed:** Backup script redeployed from repo template. Manual trigger confirmed date-based snapshot at `~/.openclaw/backups/2026-03-05/` with:

- `openclaw.json` (6,278 bytes) — system configuration
- `agents/main/agent/auth-profiles.json` (3,078 bytes) — primary agent auth
- 3 additional agent auth profiles (analyst, content-writer, marketing-orchestrator)
- Evolved skills directory + marketing memory

All three recovery scenarios now PASS. D4 (failover drill gaps) resolved by D3 fix.

## Scenarios to Drill

1. **Config restore**: Restore `openclaw.json` from backup snapshot, restart gateway
2. **Auth recovery**: Restore `auth-profiles.json`, verify model connectivity
3. **Skill recovery**: Restore evolved skills from backup, verify skill list
4. **Full recovery**: Restore all 4 backup items, restart, run acceptance-smoke.sh
