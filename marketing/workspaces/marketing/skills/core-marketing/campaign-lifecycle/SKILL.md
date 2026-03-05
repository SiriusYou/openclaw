---
name: campaign-lifecycle
description: End-to-end campaign orchestration from ideation through retrospective. Sequences existing skills into a coherent workflow with phase gates, state tracking, and feedback loops. Use when running a full campaign cycle or when unsure which phase-specific skill to invoke.
metadata:
  openclaw:
    emoji: "\U0001F504"
---

# Campaign Lifecycle Orchestrator

## Purpose

Manage the full lifecycle of a marketing campaign by sequencing phase-specific skills in the correct order, enforcing quality gates between phases, and feeding outcomes back into memory for continuous improvement.

## When to Use

- Starting a new campaign from scratch
- Resuming a campaign that stalled mid-lifecycle
- When unsure which phase-specific skill to use next
- For periodic lifecycle audits ("where are we?")

## Safety Boundaries

- Do not skip the decision gate (Phase 4) for campaigns with budget > $100 or audience > 1,000
- Do not auto-approve phase transitions — present gate results and ask for confirmation
- Do not fabricate metrics; if data is unavailable, flag the gap and recommend instrumentation
- Respect existing memory; update rather than overwrite campaign records

## Lifecycle Phases

```
Phase 1: IDEATE ──► Phase 2: PLAN ──► Phase 3: CREATE ──► Phase 4: GATE
    │                                                          │
    │                                                     [Go/No-Go]
    │                                                          │
    │              Phase 7: LEARN ◄── Phase 6: ANALYZE ◄── Phase 5: LAUNCH
    │                  │
    └──────────────────┘ (next cycle)
```

## Required Retrieval Steps

Before starting any phase, load context:

1. `memory_search('campaign lifecycle state')` — find current phase
2. `memory_search('campaign lessons learned')` — load prior learnings
3. `memory_search('<campaign-name> brief')` — load existing brief if resuming

## Step-by-Step Procedure

### Phase 1: IDEATE

**Skill**: `structured-brainstorm`

1. Define the marketing challenge or opportunity
2. Run structured brainstorm to generate 3-5 campaign concepts
3. Evaluate concepts against brand positioning (retrieve `brand-and-audience.md`)
4. Select top concept with rationale

**Gate**: Concept selected and aligned with brand? → Proceed to Phase 2

### Phase 2: PLAN

**Skill**: `campaign-brief`

1. Generate campaign brief from selected concept
2. Define: objective, audience segments, channels, timeline, budget, KPIs
3. Run `competitor-monitor` if competitive positioning is a factor
4. Optionally use `marketing-strategy-pmm` for GTM framing

**Gate**: Brief complete with measurable KPIs? → Proceed to Phase 3

### Phase 3: CREATE

**Skill**: `content-ab-test` + `content-repurposing`

1. Draft primary content asset (blog post, landing page, ad copy)
2. Design A/B test variants using `content-ab-test`
3. Repurpose primary content for distribution channels using `content-repurposing`
4. Review all assets against brand voice guidelines

**Gate**: Content ready with test variants and channel adaptations? → Proceed to Phase 4

### Phase 4: GATE (Decision Point)

**Skill**: `campaign-decision-gate`

1. Run the decision gate with full evidence:
   - Brief KPIs and budget
   - Content readiness status
   - Competitor landscape context
   - Lessons from prior campaigns
2. Produce Go / Hold / No-Go recommendation
3. If Hold: specify what's missing and which phase to revisit
4. If No-Go: document reasons and archive for future reference

**Gate**: Go decision confirmed? → Proceed to Phase 5

### Phase 5: LAUNCH

1. Execute launch per brief timeline and channel plan
2. Record launch date, channels activated, and initial distribution metrics
3. Set up monitoring cadence (daily for first week, then per brief schedule)
4. Store launch state: `memory_search` then update with launch metadata

**Gate**: Campaign live and monitoring active? → Proceed to Phase 6

### Phase 6: ANALYZE

**Skills**: `weekly-summary` + `campaign-diagnosis`

1. Run `weekly-summary` to capture performance snapshot
2. Compare actuals vs brief KPIs
3. If underperforming: run `campaign-diagnosis` for root cause analysis
4. If A/B test running: evaluate test results and pick winner
5. Use `campaign-decision-gate` for any mid-flight adjustments

**Gate**: Performance data collected and analyzed? → Proceed to Phase 7

### Phase 7: LEARN

**Skill**: `campaign-retrospective`

1. Run full retrospective with outcome data
2. Extract reusable lessons in "If X, then Y" format
3. Update memory with validated lessons: `memory_search('campaign lessons learned')` then append
4. Identify skill gaps exposed during this cycle
5. Feed gaps into evolution system (inform next `marketing-evolution-semimonthly` run)

**Gate**: Lessons stored in memory and gaps documented? → Cycle complete

## State Tracking

After each phase transition, store state in memory:

```markdown
## Campaign: <name>

- **Current Phase**: <1-7>
- **Phase Status**: <completed/in-progress/blocked>
- **Last Updated**: <date>
- **Key Decisions**: <brief summary>
- **Blockers**: <if any>
```

## Output Format Template

```markdown
# Campaign Lifecycle Status: <Campaign Name>

## Current State

- **Phase**: <phase number and name>
- **Status**: <on-track / at-risk / blocked>
- **Days in Phase**: <N>

## Phase History

| Phase     | Started    | Completed  | Gate Result      | Notes          |
| --------- | ---------- | ---------- | ---------------- | -------------- |
| 1. IDEATE | YYYY-MM-DD | YYYY-MM-DD | Concept selected | <concept name> |
| 2. PLAN   | YYYY-MM-DD | YYYY-MM-DD | Brief approved   | <KPI summary>  |
| ...       |            |            |                  |                |

## Next Action

- **Phase**: <next phase>
- **Skill to invoke**: <skill name>
- **Prerequisites**: <what's needed>

## Lessons Applied (from prior cycles)

- <lesson 1>
- <lesson 2>
```

## Quality Checklist

- [ ] Did I check memory for existing campaign state before starting?
- [ ] Did I invoke the correct phase-specific skill (not just summarize)?
- [ ] Did I enforce the gate between phases (not skip ahead)?
- [ ] Did I store updated state in memory after each phase transition?
- [ ] Did I apply lessons from prior campaigns (Phase 7 → Phase 1 loop)?
- [ ] Did I flag data gaps rather than fabricate metrics?
