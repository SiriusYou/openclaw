---
name: campaign-decision-gate
description: Structured Go/Hold/No-Go decision gate for campaign launches. Evaluates evidence checklist and produces a recommendation with rationale. Use at Phase 4 (GATE) of campaign-lifecycle.
metadata:
  openclaw:
    emoji: "\U0001F6A6"
---

# Campaign Decision Gate

## Purpose

Provide a structured, evidence-based Go / Hold / No-Go recommendation for a campaign before launch. Collects evidence against a checklist, scores each criterion, and applies decision rules.

## When to Use

- Phase 4 (GATE) of campaign-lifecycle — before any campaign launch
- Mid-flight adjustment decisions during Phase 6 (ANALYZE)
- Any time operator asks "should we proceed?"

## Safety Boundaries

- Do NOT auto-approve — present the recommendation and require explicit operator confirmation
- Do NOT fabricate evidence; if data is unavailable, score as "Unknown" and flag the gap
- Do NOT proceed past a No-Go without operator override and documented rationale
- Budget decisions above $100 require explicit operator sign-off regardless of gate result

## Required Retrieval Steps

1. `memory_search('<campaign-name> brief')` — load campaign brief with KPIs and budget
2. `memory_search('campaign lessons learned')` — check for relevant prior lessons
3. `memory_search('<campaign-name> content')` — verify content readiness

## Step-by-Step Procedure

1. **Gather evidence** for each criterion in the checklist below
2. **Score each criterion**: Pass / Fail / Partial / Unknown
3. **Apply decision rules**:
   - All hard criteria Pass → **Go** recommendation
   - Any hard criterion Fail → **No-Go** recommendation
   - Any hard criterion Partial or Unknown → **Hold** with remediation list
   - Bonus criteria do not block but are noted
4. **Document rationale** for the recommendation
5. **List next actions** based on the decision

### Evidence Checklist

**Hard criteria** (all must Pass for Go):

| #   | Criterion            | Evidence Source                                                |
| --- | -------------------- | -------------------------------------------------------------- |
| H1  | Brief complete       | Campaign brief exists with objective, audience, channels, KPIs |
| H2  | Channel confirmed    | Distribution channel is active and accessible                  |
| H3  | Recipients confirmed | Target audience/list specified with estimated size             |
| H4  | Content ready        | Primary content drafted and reviewed                           |
| H5  | Budget approved      | Budget within allocated limits (or operator override)          |

**Bonus criteria** (skip if not ready, note reason):

| #   | Criterion              | Evidence Source                                  |
| --- | ---------------------- | ------------------------------------------------ |
| B1  | A/B variants prepared  | Test variants created via content-ab-test        |
| B2  | Short links configured | Tracked links created for distribution URLs      |
| B3  | Lessons applied        | Relevant prior lessons reviewed and incorporated |

## Output Format Template

```markdown
# Decision Gate: <Campaign Name>

## Evidence

| #   | Criterion            | Score   | Evidence                         |
| --- | -------------------- | ------- | -------------------------------- |
| H1  | Brief complete       | Pass    | Brief dated YYYY-MM-DD, 5 KPIs   |
| H2  | Channel confirmed    | Pass    | Telegram bot active              |
| H3  | Recipients confirmed | Pass    | 500 subscribers                  |
| H4  | Content ready        | Partial | Draft done, review pending       |
| H5  | Budget approved      | Pass    | $50, within limit                |
| B1  | A/B variants         | Skip    | Not applicable for this campaign |
| B2  | Short links          | Pass    | 2 tracked links created          |
| B3  | Lessons applied      | Pass    | 2 lessons from prior campaign    |

## Recommendation: **Hold**

### Rationale

H4 scored Partial — content review not yet complete.

### Remediation

1. Complete content review (estimated: 1 day)
2. Re-run gate after review

### Next Actions

- [ ] Complete content review
- [ ] Re-run decision gate
```

## Quality Checklist

- [ ] All hard criteria evaluated (none skipped)
- [ ] Each score backed by specific evidence (not assumptions)
- [ ] Decision rules applied correctly (Go/Hold/No-Go logic)
- [ ] Recommendation presented to operator (not auto-executed)
- [ ] Unknown scores flagged with what data is needed
- [ ] Prior lessons checked and incorporated
