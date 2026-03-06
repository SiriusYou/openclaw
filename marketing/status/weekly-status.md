# Weekly Status Snapshot

_Fill in each Monday. Keep history for trend tracking._

## Template

### Week of YYYY-MM-DD

| #   | Health Indicator       | Status              | Notes                   |
| --- | ---------------------- | ------------------- | ----------------------- |
| 1   | Gateway uptime (7d)    | \_\_%               |                         |
| 2   | Cron success rate (7d) | **/** runs OK       |                         |
| 3   | Daily cost (7d avg)    | $**.**              | NORMAL/WARNING/CRITICAL |
| 4   | Telegram delivery      | OK/DEGRADED/DOWN    |                         |
| 5   | Evolved skills (total) | \_\_                | New this week: \_\_     |
| 6   | Backup freshness       | \_\_h ago           | Last: YYYY-MM-DD        |
| 7   | Upstream drift         | \_\_ commits behind |                         |
| 8   | Open issues            | \_\_                |                         |

**Action items**: _(list any follow-ups)_

---

## History

### Week of 2026-03-03

| #   | Health Indicator       | Status              | Notes                                                   |
| --- | ---------------------- | ------------------- | ------------------------------------------------------- |
| 1   | Gateway uptime (7d)    | ~95%                | Mac sleep interruptions                                 |
| 2   | Cron success rate (7d) | 4/4 jobs enabled    | All running                                             |
| 3   | Daily cost (7d avg)    | ~$0.50              | Subscription-based, minimal API                         |
| 4   | Telegram delivery      | OK                  | @Jiayo_bot active                                       |
| 5   | Evolved skills (total) | 3                   | content-repurposing, competitor-monitor, weekly-summary |
| 6   | Backup freshness       | N/A                 | Backup system just deployed                             |
| 7   | Upstream drift         | 0                   | Synced 2026-03-05                                       |
| 8   | Open issues            | P2: evolution dedup | Known risk                                              |

**Action items**: Run first backup, verify launchd job loads

---

### Week of 2026-03-05

| #   | Health Indicator       | Status              | Notes                                                                                                         |
| --- | ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Gateway uptime (7d)    | ~95%                | Mac sleep interruptions                                                                                       |
| 2   | Cron success rate (7d) | 6/6 jobs enabled    | Added marketing-smoke-daily                                                                                   |
| 3   | Daily cost (7d avg)    | ~$0.50              | Subscription-based, minimal API                                                                               |
| 4   | Telegram delivery      | OK                  | @Jiayo_bot active                                                                                             |
| 5   | Evolved skills (total) | 5                   | New: campaign-decision-gate, campaign-retrospective                                                           |
| 6   | Backup freshness       | Active              | Job active, multiple records since 2026-03-01. Git-based (workspace only; config+auth need template redeploy) |
| 7   | Upstream drift         | 0                   | Synced 2026-03-05                                                                                             |
| 8   | Open issues            | P2: evolution dedup | Prompt-level mitigation applied (step 1b recency check); platform-level idempotency guard deferred            |

**Action items**: Redeploy backup template to ~/.openclaw/scripts/daily-backup.sh (repo version already includes config+auth); evolution idempotency prompt-level mitigation applied
