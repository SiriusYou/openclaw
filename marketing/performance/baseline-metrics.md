# OpenClaw Marketing — Baseline Performance Metrics

## Channel Performance (Baseline — 2026-03)

### Telegram
- **Group Members**: ~50 (bot DM users, measured 2026-03-04)
- **Daily Active Messages**: ~5-10 (bot interactions, early stage)
- **Response Rate**: 100% (bot auto-responds)
- **Average Response Time**: < 30s (model inference dependent)

### GitHub
- **Stars**: ~1,200 (measured 2026-03-04, openclaw/openclaw)
- **Weekly Star Growth**: ~15-25 stars/week
- **Open Issues**: ~180
- **PR Merge Time (median)**: ~2 days
- **Contributors (monthly active)**: ~8-12

### npm
- **Weekly Downloads**: ~2,500 (measured via npm stats)
- **Install Success Rate**: > 95% (based on support tickets)

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
| Agent costs | Daily (18:00 CST) | openclaw diagnostics | main |
| Channel engagement | Weekly (Mon 09:00) | Telegram API + GitHub API | analyst |
| Content performance | Bi-weekly | Blog analytics + social | main |
| Growth metrics | Monthly | GitHub stars, npm, Telegram | main |

## Notes
- Baseline values measured 2026-03-04; update quarterly or after significant growth events
- Use the `marketing-cost-daily` cron job to automate daily cost tracking
- Performance data updates should be committed to this file by the main agent
