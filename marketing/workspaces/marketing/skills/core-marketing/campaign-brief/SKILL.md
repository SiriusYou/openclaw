---
name: campaign-brief
description: Generate structured campaign briefs from high-level objectives. Use when planning a new marketing campaign or initiative.
metadata:
  openclaw:
    emoji: "\U0001F4CB"
---

# Campaign Brief Generator

When asked to create a campaign brief, follow this structure:

## Brief Template

1. **Campaign Name**: Descriptive, memorable
2. **Objective**: SMART goal (Specific, Measurable, Achievable, Relevant, Time-bound)
3. **Target Audience**: Primary and secondary personas
4. **Key Message**: Core value proposition (max 1 sentence)
5. **Channels**: Distribution channels with rationale
6. **Timeline**: Start/end dates, milestones
7. **Budget Allocation**: By channel (percentage)
8. **KPIs**: 3-5 measurable metrics
9. **Creative Direction**: Tone, visual style, references
10. **Risks & Mitigations**: Top 3 risks

## Process

1. Search memory for past campaign performance: `memory_search("campaign performance")`
2. Review lessons learned: `memory_get("MEMORY.md")`
3. Generate brief using template above
4. Compare with successful past campaigns
5. Flag any conflicts with brand guidelines
