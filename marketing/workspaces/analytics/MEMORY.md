# Marketing Analyst Knowledge Base

## KPI Dashboard

| Metric                         | Current            | Target                 | Trend    |
| ------------------------------ | ------------------ | ---------------------- | -------- |
| Campaign phases completed      | 7/7 (R4)           | 7/7 (R5)               | Stable   |
| Lessons extracted per campaign | 3 (R4)             | ≥1 (R5)                | Baseline |
| Link click tracking            | Not yet configured | ≥1 click recorded (D3) | New      |
| Evolved skills (total)         | 5                  | Organic growth         | Stable   |
| Cron health (6 jobs)           | 6/6 enabled        | 6/6 within window      | Stable   |

## Data Sources

| Source                   | Type              | Refresh Frequency | Notes                                                       |
| ------------------------ | ----------------- | ----------------- | ----------------------------------------------------------- |
| Short link service (TBD) | Click tracking    | Real-time         | D3 deliverable — primary campaign analytics                 |
| Telegram chat            | Replies/reactions | Manual count      | Hand-counted post-publish, informational only               |
| `weekly-status.md`       | System health     | Weekly (Monday)   | Git drift, cron, tests, open issues                         |
| `cron-health-check.sh`   | Cron staleness    | On-demand         | Per-job windows: daily≤48h, weekly≤8d, semi≤20d, health≤12h |
| `acceptance-smoke.sh`    | System acceptance | On-demand         | 14 assertions across T1/T2/T5/T8                            |

## Measurement Methodology (from R4 Lessons)

- **Native TG view counts are unreliable** for non-admin bots — do not use as primary metric
- **Short links** are the default tracking method (D3 deliverable)
- **Pass/Fail gates**: timing compliance (Tue-Thu 09-11AM), phase completion, lesson extraction
- **Informational metrics**: clicks, engagement — recorded but not used for pass/fail in R5
- **Statistcal caveat**: R5 is single-recipient DM (process validation), not effect validation; meaningful CTR/engagement rates require audience scale (R7+)

## Weekly Reports

| Week       | Key Wins                            | Key Issues                                     | Recommendations                             |
| ---------- | ----------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| 2026-03-07 | R4 pilot 7/7 phases, 3 lessons      | TG view counts unreliable, weekend timing poor | Apply lessons in R5; add link tracking (D3) |
| 2026-03-09 | D0 rebaseline complete, 31/31 tests | 52 commits ahead (long branch)                 | D2 branch merge PR-A before R5              |

## Cost Analysis

| Date       | Agent           | Tokens        | Cost ($) | Actions  | Cost/Action |
| ---------- | --------------- | ------------- | -------- | -------- | ----------- |
| 2026-03-07 | main (R4 pilot) | ~subscription | ~$0.00   | 7 phases | ~$0/phase   |

## Model Performance

| Model                | Agent                | Avg Latency | Token Efficiency | Notes                                    |
| -------------------- | -------------------- | ----------- | ---------------- | ---------------------------------------- |
| gpt-5.3-codex        | main, content-writer | ~3-5s       | Good             | Primary via openai-codex subscription    |
| gemini-3-pro-preview | analyst              | ~2-4s       | Good             | Primary for analyst, fallback for others |
| openrouter (auto)    | all                  | Variable    | Variable         | Last-resort fallback                     |
