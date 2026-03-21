# Baseline Performance Metrics

## Channel Performance (Baseline)

### Telegram

- **Group Members**: _to be measured_
- **Daily Active Messages**: _to be measured_
- **Response Rate**: 100% (bot auto-responds)
- **Average Response Time**: < 30s (model inference dependent)

### Other Channels

- _Add metrics for each active channel_

## Cost Metrics (Baseline)

### Agent Operating Costs

- **Daily Budget Target**: < $YOUR_BUDGET/day
- **Cost Breakdown by Provider**:
  - google: API key (Gemini API)
  - openrouter: pay-per-use (fallback)

### Cost Alert Thresholds

- **Warning**: > YOUR_WARNING_THRESHOLD/day
- **Critical**: > YOUR_CRITICAL_THRESHOLD/day
- **Action**: Reduce agent frequency, review model selection

## Content Performance Benchmarks

### Telegram Announcements

- **Target Read Rate**: > 60% of group members
- **Target Engagement (reactions/replies)**: > 10% of readers

## Measurement Schedule

| Metric              | Frequency | Source               | Agent |
| ------------------- | --------- | -------------------- | ----- |
| Agent costs         | Daily     | openclaw diagnostics | main  |
| Channel engagement  | Weekly    | Channel APIs         | main  |
| Content performance | Bi-weekly | Analytics            | main  |
| Growth metrics      | Monthly   | Platform stats       | main  |

## Notes

- Update baseline values quarterly or after significant growth events
- Use weekly summary cron job to automate performance tracking
