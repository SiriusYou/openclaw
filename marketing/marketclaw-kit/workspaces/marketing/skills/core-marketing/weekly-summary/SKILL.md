---
name: weekly-summary
description: Generate weekly campaign performance summary with KPI tracking, click data, and action items. Use during Phase 6 (ANALYZE) of campaign-lifecycle or for scheduled weekly reporting.
metadata:
  openclaw:
    emoji: "\U0001F4CA"
---

# Weekly Summary

## Purpose

Produce a concise weekly performance snapshot for all active campaigns, comparing actual metrics against brief KPIs, and surfacing campaigns at risk.

## When to Use

- Phase 6 (ANALYZE) of campaign-lifecycle
- Weekly reporting cron (every Monday)
- When operator asks "how are campaigns doing?"

## Safety Boundaries

- Do not fabricate metrics — if data is unavailable, report the gap explicitly
- Do not delete or overwrite existing status entries — append new data
- Do not make optimization decisions — present data and flag risks for operator review
- If no campaigns are active, report "No active campaigns" rather than inventing data

## Required Retrieval Steps

1. `memory_search('campaign lifecycle state')` — find active campaigns and their phases
2. `memory_search('campaign performance')` — load any tracked metrics
3. `memory_search('weekly status')` — check for prior week's data to compare

## Step-by-Step Procedure

1. **List active campaigns**: retrieve all campaigns not in Phase 7 (LEARN) or archived
2. **For each campaign**:
   a. Record current phase and days in phase
   b. Pull KPI targets from campaign brief
   c. Pull actual metrics (click data from short links if configured, engagement data)
   d. Compare actuals vs targets: on-track / at-risk / behind
   e. Note any blockers
3. **Aggregate totals**: total active campaigns, total spend (if tracked), overall health
4. **Flag at-risk campaigns**: any campaign behind target by >20% or blocked for >3 days
5. **List action items**: specific next steps for each at-risk campaign
6. **Write summary** to `status/weekly-status.md` in the workspace (append, do not overwrite)

## Output Format Template

```markdown
# Weekly Summary — Week of YYYY-MM-DD

## Overview

- **Active campaigns**: N
- **On track**: N | **At risk**: N | **Behind**: N
- **Total spend**: $X (if tracked)

## Campaign Status

| Campaign | Phase      | Days | KPI Target | Actual    | Status   |
| -------- | ---------- | ---- | ---------- | --------- | -------- |
| <name>   | 5. LAUNCH  | 3    | 100 clicks | 45 clicks | On track |
| <name>   | 6. ANALYZE | 7    | 500 views  | 180 views | At risk  |

## Click Data (if short links configured)

| Campaign | Link      | Human Clicks | Top Region | Period  |
| -------- | --------- | ------------ | ---------- | ------- |
| <name>   | oc-xxx-tw | 23           | US         | Last 7d |

## At-Risk Campaigns

### <Campaign Name>

- **Issue**: behind target by 64% (180/500 views)
- **Root cause**: (if known)
- **Recommended action**: run campaign-diagnosis skill

## Action Items

1. [ ] <specific action for campaign X>
2. [ ] <specific action for campaign Y>

## Data Gaps

- <list any metrics that could not be retrieved>
```

## Quality Checklist

- [ ] All active campaigns included (none missed)
- [ ] KPI targets sourced from campaign briefs (not assumed)
- [ ] Actual metrics sourced from data (not fabricated)
- [ ] Data gaps explicitly noted
- [ ] At-risk campaigns flagged with specific thresholds
- [ ] Action items are specific and actionable
- [ ] Summary appended to status/weekly-status.md in the workspace (not overwritten)
