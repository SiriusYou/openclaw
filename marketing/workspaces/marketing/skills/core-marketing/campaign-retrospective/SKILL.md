---
name: campaign-retrospective
description: Post-campaign retrospective to extract reusable lessons in "If X, then Y" format. Use at Phase 7 (LEARN) of campaign-lifecycle after campaign completion.
metadata:
  openclaw:
    emoji: "\U0001F4DD"
---

# Campaign Retrospective

## Purpose

Run a structured post-campaign retrospective that compares outcomes against the original brief KPIs, identifies what worked and what did not, and extracts reusable lessons in a standardized format for future campaigns.

## When to Use

- Phase 7 (LEARN) of campaign-lifecycle — after campaign completion
- After a campaign is cancelled or paused (extract partial learnings)
- Quarterly review of multiple campaigns

## Safety Boundaries

- Do not fabricate metrics — use only data from the campaign record and click tracking
- Do not delete prior lessons — append new ones to the existing file
- Do not skip the "what didn't work" section — incomplete retrospectives create blind spots
- Lessons must be specific and actionable, not generic platitudes

## Required Retrieval Steps

1. `memory_search('<campaign-name> brief')` — load original objectives and KPIs
2. `memory_search('<campaign-name> performance')` — load outcome data
3. `memory_search('campaign lessons learned')` — load existing lessons to avoid duplicates

## Step-by-Step Procedure

1. **Summarize campaign**: name, objective, timeline, channels, budget
2. **Compare outcomes vs KPIs**: for each KPI in the brief, record target vs actual
3. **Identify what worked** (KEEP):
   - List 2-5 specific practices that contributed to positive outcomes
   - Cite evidence (e.g. "Telegram thread format drove 3x more clicks than single message")
4. **Identify what didn't work** (CHANGE):
   - List 2-5 specific issues that hurt outcomes or caused friction
   - Cite evidence where available
5. **Extract lessons** in "If X, then Y" format:
   - Each lesson must be specific enough to apply in a future campaign
   - Check against existing lessons to avoid duplicates
   - Include context: which campaign, what phase, what evidence
6. **Identify skill gaps**: practices or capabilities that were missing during this campaign
7. **Append validated lessons** to `memory/campaign-lessons-learned.md` in the workspace
8. **Append monthly summary** to `status/monthly-status.md` in the workspace (campaigns completed, KPI outcomes, lessons extracted, skill gaps)
9. **Update campaign state** in memory to Phase 7 complete

## Output Format Template

```markdown
# Retrospective: <Campaign Name>

## Campaign Summary

- **Objective**: <from brief>
- **Timeline**: YYYY-MM-DD to YYYY-MM-DD
- **Channels**: <list>
- **Budget**: $X spent of $Y allocated

## Outcomes vs KPIs

| KPI               | Target | Actual | Result    |
| ----------------- | ------ | ------ | --------- |
| Clicks            | 100    | 78     | -22% miss |
| Subscriber growth | 50     | 63     | +26% beat |

## What Worked (KEEP)

1. **<practice>**: <evidence>
2. **<practice>**: <evidence>

## What Didn't Work (CHANGE)

1. **<issue>**: <evidence>
2. **<issue>**: <evidence>

## Lessons Learned

Format: "If X, then Y" — each lesson is a reusable rule.

1. **If** launching on Telegram with a long announcement, **then** split into a thread (3-5 messages) rather than a single wall of text — engagement was 3x higher in thread format (Campaign: <name>, Phase 5).
2. **If** targeting developer audience on weekdays, **then** launch Tue-Thu 10:00-11:00 CST — Monday launches had 40% lower open rates (Campaign: <name>, Phase 6).

## Skill Gaps Identified

- <capability that was missing or insufficient>
- <tool or process that would have helped>

## Actions

- [ ] Lessons appended to memory/campaign-lessons-learned.md
- [ ] Monthly summary appended to status/monthly-status.md
- [ ] Campaign state updated to Phase 7 complete
- [ ] Skill gaps reported for evolution system
```

## Quality Checklist

- [ ] All brief KPIs compared with actual outcomes
- [ ] "What worked" section has at least 2 entries with evidence
- [ ] "What didn't work" section has at least 1 entry (never empty)
- [ ] Lessons use "If X, then Y" format consistently
- [ ] No duplicate lessons (checked against existing file)
- [ ] Sources cited for each lesson (campaign name, phase)
- [ ] Lessons appended to memory/campaign-lessons-learned.md in the workspace (not overwritten)
- [ ] Skill gaps documented for evolution system
