---
name: launch-readiness
description: Pre-launch readiness assessment with scored checklist and GO/HOLD/NO-GO decision. Extracted from campaign-lifecycle Phase 5 for standalone use. Invoke before any campaign send to verify all hard requirements are met.
metadata:
  openclaw:
    emoji: "\U0001F680"
---

# Launch Readiness Assessment

## Purpose

Score every pre-launch checklist item as PASS or FAIL with concrete evidence, then produce a GO / HOLD / NO-GO decision. This is the final gate between content approval and campaign delivery.

## When to Use

- Before executing Phase 5 (LAUNCH) of campaign-lifecycle
- As a standalone pre-send check for any campaign or broadcast
- When operator asks "are we ready to launch?" or "pre-flight check"
- Before `openclaw message send` or `aitoearn-publish` delivery

## Safety Boundaries

- Do NOT auto-send — always present the decision and wait for explicit operator confirmation
- Do NOT mark a hard item as PASS without verifiable evidence (logs, config output, screenshots)
- Do NOT proceed past NO-GO without operator override and documented rationale
- If any evidence is unavailable, score as FAIL (not "Unknown") — launch requires certainty

## Required Retrieval Steps

1. `memory_search('<campaign-name> brief')` — load campaign brief (channel, recipients, timeline)
2. `memory_search('<campaign-name> content')` — verify content status and approval
3. `memory_search('campaign lessons learned')` — check for relevant prior lessons
4. Verify channel status: search memory for channel configuration evidence (`memory_search('channel status')`) or ask operator to confirm channel is active
5. Verify send policy: search memory for send policy configuration (`memory_search('sendPolicy')`) or ask operator to confirm policy permits the delivery path

## Scoring System

Each checklist item receives one of two scores:

| Score | Meaning | Evidence Required |
| ----- | ------- | ----------------- |
| **PASS** | Criterion met with verifiable evidence | Specific evidence cited (command output, config value, approval record) |
| **FAIL** | Criterion not met or evidence unavailable | What is missing and what action resolves it |

There is no Partial or Unknown — launch requires binary certainty on every hard item.

## Checklist

### Hard Items (ALL must PASS — any FAIL triggers HOLD or NO-GO)

| ID | Criterion | How to Verify | PASS When |
| -- | --------- | ------------- | --------- |
| H1 | **Content approved** | Campaign content exists, has been reviewed, and operator approved it | Content draft finalized and operator gave explicit approval |
| H2 | **Channel configured** | Memory search for channel config or operator confirmation | Channel is active and configured for the target platform |
| H3 | **Recipients confirmed** | Recipient list or audience segment matches the PLAN phase brief | Recipients specified, count matches brief estimate, no empty lists |
| H4 | **Send policy verified** | Memory search for sendPolicy config or operator confirmation | Send policy permits delivery to the target session type |

### Bonus Items (can skip with documented reason — do not block launch)

| ID | Criterion | How to Verify | Skip Reason Template |
| -- | --------- | ------------- | -------------------- |
| B1 | **Short link embedded** | Campaign URLs use tracked short links (e.g. Short.io) | `"no_tracking: <reason>"` — record in weekly-status |
| B2 | **A/B variant prepared** | Multiple content variants created via content-ab-test | `"single_variant: <reason>"` — note in campaign brief |

## Decision Rules

Apply these rules strictly based on hard item scores:

```
IF all H1-H4 = PASS                           → GO
IF any H1-H4 = FAIL and fixable (< 24h)       → HOLD  (list remediation steps)
IF any H1-H4 = FAIL and not quickly fixable    → NO-GO (document reasons, archive)
```

**Operator override**: A NO-GO or HOLD can be overridden with explicit operator confirmation. The override and its rationale MUST be recorded in the evidence summary.

## Step-by-Step Procedure

1. **Load context**: run all Required Retrieval Steps above
2. **Score each hard item (H1-H4)**: verify evidence, record PASS or FAIL with specific proof
3. **Score each bonus item (B1-B2)**: verify or document skip reason
4. **Check timing window**: launch falls within Tue-Thu 09:00-11:00 UTC+8 (optimal engagement). If outside window, flag as a warning (does not block, but requires acknowledgment)
5. **Apply decision rules**: determine GO / HOLD / NO-GO
6. **Present the readiness report** to operator — do NOT auto-send
7. **Wait for explicit confirmation** before proceeding to launch execution
8. **Record the decision**: store in campaign state via memory

## Output Format Template

Use this format for the readiness report. Reference `campaign-decision-gate` for the decision presentation style.

```markdown
# Launch Readiness: <Campaign Name>

**Date**: YYYY-MM-DD
**Assessed by**: <agent or operator>

## Hard Items

| ID | Criterion | Score | Evidence |
| -- | --------- | ----- | -------- |
| H1 | Content approved | PASS | Content finalized YYYY-MM-DD, operator approved in chat |
| H2 | Channel configured | PASS | `openclaw channels status --probe` — Telegram: connected |
| H3 | Recipients confirmed | PASS | DM to chat_id 8113291785 + Openclaw Dev group (-5234143314) |
| H4 | Send policy verified | PASS | sendPolicy rule `agent:main:` covers target session |

## Bonus Items

| ID | Criterion | Score | Evidence / Skip Reason |
| -- | --------- | ----- | ---------------------- |
| B1 | Short link embedded | PASS | jiayou.short.gy/abc123 created |
| B2 | A/B variant prepared | SKIP | single_variant: pilot campaign, no split test needed |

## Timing Check

- **Planned send**: YYYY-MM-DD HH:MM UTC+8
- **In optimal window** (Tue-Thu 09-11 UTC+8): Yes / No (⚠️ outside window — acknowledge before proceeding)

## Decision: **GO**

### Rationale

All hard criteria passed. Short links configured for tracking. Sending within optimal engagement window.

### Pre-Send Actions

- [ ] Operator confirms GO
- [ ] Execute send via `openclaw message send` or `aitoearn-publish`
- [ ] Record launch metadata in campaign state

### If HOLD — Remediation

1. <what needs fixing>
2. <estimated time to fix>
3. Re-run launch-readiness after fix
```

## Integration with Campaign Lifecycle

This skill maps to **Phase 5 (LAUNCH)** of `campaign-lifecycle`. When invoked within the lifecycle:

- Phase 4 GATE (`campaign-decision-gate`) must have returned **Go** before running this skill
- After this skill returns **GO** and operator confirms, proceed with launch execution
- After launch, transition to Phase 6 (ANALYZE)

When invoked standalone (outside campaign-lifecycle), this skill is self-contained and does not require prior phase completion.

## Quality Checklist

- [ ] All 4 hard items evaluated with specific evidence (no assumptions)
- [ ] Each FAIL includes what is missing and how to fix it
- [ ] Bonus items scored or skipped with documented reason
- [ ] Timing window checked and flagged if outside optimal range
- [ ] Decision rules applied correctly (GO only when all hard items PASS)
- [ ] Report presented to operator before any send action
- [ ] Prior campaign lessons checked and relevant ones noted
- [ ] Decision recorded in campaign state for audit trail
