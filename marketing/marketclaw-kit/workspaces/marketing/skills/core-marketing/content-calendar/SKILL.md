---
name: content-calendar
description: Plan weekly and monthly content schedules with platform-specific timing, content types, and topic mapping. Use during campaign-lifecycle Phase 2 (PLAN).
metadata:
  openclaw:
    emoji: "\U0001F4C5"
---

# Content Calendar Planner

When asked to create a content calendar, follow this procedure:

## Inputs

1. **Campaign Brief**: The approved campaign brief (from campaign-brief skill or manual input)
2. **Target Platforms**: Which platforms to schedule for (Telegram, Twitter/X, LinkedIn, etc.)
3. **Posting Frequency**: Posts per platform per week (e.g. "3x Twitter, 1x Telegram")
4. **Date Range**: Start and end dates for the calendar period

## Process

1. Search memory for past campaign calendars and performance data:
   - `memory_search("content calendar")`
   - `memory_search("campaign performance")`
   - `memory_search("campaign lessons")`
2. Review lessons learned from previous campaigns: `memory_get("MEMORY.md")`
3. Identify content pillars from the campaign brief's key message and objectives
4. Map content types to platforms based on platform strengths:
   - **Twitter/X**: Short takes, threads, polls, links
   - **Telegram**: Deep dives, announcements, community Q&A
   - **LinkedIn**: Thought leadership, case studies, milestones
   - **Blog**: Tutorials, technical deep dives, announcements
5. Distribute topics across the date range, avoiding clustering
6. Flag any scheduling conflicts (holidays, competing campaigns, low-engagement windows)

## Output Format

Generate a structured calendar using this template:

```
## Content Calendar: [Campaign Name]
Period: [Start Date] – [End Date]

### Week of [Date]

| Day | Platform | Content Type | Topic | Status |
|-----|----------|-------------|-------|--------|
| Mon | Twitter  | Thread      | ...   | Draft  |
| Tue | Telegram | Announcement| ...   | Draft  |
| Wed | LinkedIn | Article     | ...   | Draft  |
| Thu | Twitter  | Poll        | ...   | Draft  |
| Fri | Twitter  | Short take  | ...   | Draft  |

### Week of [Date]
...
```

## Scheduling Guidelines

- **Spacing**: Spread content evenly; avoid posting on the same platform on consecutive days unless frequency demands it
- **Variety**: Alternate content types within each platform (don't post 3 threads in a row)
- **Timing**: Note optimal posting windows per platform if known from past data
- **Dependencies**: Mark content that requires assets, approvals, or prerequisites
- **Buffer**: Leave 1-2 flexible slots per week for reactive/timely content

## Safety Boundaries

- Do not schedule more than 2 posts per channel per day
- Do not auto-publish — the calendar is a planning artifact only
- Flag any day with zero scheduled content across all channels as a gap
- Do not overwrite existing calendar entries without explicit confirmation
- Respect platform rate limits when suggesting posting frequency

## Integration

- **Phase**: campaign-lifecycle Phase 2 (PLAN)
- **Input from**: campaign-brief skill (Phase 1 output)
- **Output to**: content creation workflow (Phase 3 CREATE)
- Save completed calendar to `marketing/memory/` for future reference

## Quality Checklist

- [ ] Did I check memory for existing calendars and past performance data?
- [ ] Does the calendar cover the full requested date range with no gaps?
- [ ] Is content variety maintained (no 3+ identical content types in a row per platform)?
- [ ] Are all days within the range covered by at least one post across channels?
- [ ] Does posting frequency match the requested cadence per platform?
- [ ] Are scheduling conflicts (holidays, competing campaigns) flagged?
- [ ] Are 1-2 buffer slots per week reserved for reactive content?
- [ ] Is the calendar stored in memory for future reference?
