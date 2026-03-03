# OpenClaw Marketing — Baseline Performance Metrics

## Channel Performance (Baseline — 2026-03)

### Telegram
- **Group Members**: TBD (measure on Day 1)
- **Daily Active Messages**: TBD
- **Response Rate**: TBD
- **Average Response Time**: TBD

### GitHub
- **Stars**: TBD (measure on Day 1)
- **Weekly Star Growth**: TBD
- **Open Issues**: TBD
- **PR Merge Time (median)**: TBD
- **Contributors (monthly active)**: TBD

### npm
- **Weekly Downloads**: TBD (measure via `npm view openclaw` stats)
- **Install Success Rate**: TBD

## Cost Metrics (Baseline)

### Agent Operating Costs
- **Daily Budget Target**: < $20/day across all agents
- **Cost Breakdown by Provider**:
  - openai-codex: subscription-based (Plus plan, ~$20/month)
  - google: free tier (Gemini API)
  - openrouter: pay-per-use (fallback only, minimal cost)

### Cost Alert Thresholds
- **Warning**: > $15/day (75% of budget)
- **Critical**: > $20/day (100% of budget)
- **Action**: Reduce agent frequency, review model selection

## Content Performance Benchmarks

### Blog Posts
- **Target Views (first week)**: > 100
- **Target Time on Page**: > 3 minutes
- **Target Social Shares**: > 10

### Telegram Announcements
- **Target Read Rate**: > 60% of group members
- **Target Engagement (reactions/replies)**: > 10% of readers

## Measurement Schedule

| Metric | Frequency | Source | Agent |
|--------|-----------|--------|-------|
| Agent costs | Daily (18:00 CST) | openclaw diagnostics | analyst |
| Channel engagement | Weekly (Mon 09:00) | Telegram API + GitHub API | analyst |
| Content performance | Bi-weekly | Blog analytics + social | main |
| Growth metrics | Monthly | GitHub stars, npm, Telegram | main |

## Notes
- All TBD values should be filled after Day 1 gateway startup
- Use the `marketing-cost-daily` cron job (Day 5) to automate cost tracking
- Performance data updates should be committed to this file by the analyst agent
