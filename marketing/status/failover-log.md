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

## Example Entry

| Date       | Trigger       | Scenario               | Result | Recovery Time | Notes                                            |
| ---------- | ------------- | ---------------------- | ------ | ------------- | ------------------------------------------------ |
| 2026-03-05 | Initial setup | Backup restore dry-run | pass   | 2m            | Verified backup script, diff against live config |

## Scenarios to Drill

1. **Config restore**: Restore `openclaw.json` from backup snapshot, restart gateway
2. **Auth recovery**: Restore `auth-profiles.json`, verify model connectivity
3. **Skill recovery**: Restore evolved skills from backup, verify skill list
4. **Full recovery**: Restore all 4 backup items, restart, run acceptance-smoke.sh
