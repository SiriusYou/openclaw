# OpenClaw Marketing — Campaign Playbook

## Campaign Lifecycle

All campaigns follow the 7-phase `campaign-lifecycle` skill:
**IDEATE → PLAN → CREATE → GATE → LAUNCH → ANALYZE → LEARN**

### Phase Checklist

| Phase   | Key Action                            | Output                                                      |
| ------- | ------------------------------------- | ----------------------------------------------------------- |
| IDEATE  | Brainstorm concepts, retrieve lessons | Concept selection + rationale                               |
| PLAN    | Define brief with hard constraints    | `campaign-brief.md` with channel, recipients, timing, scope |
| CREATE  | Draft content + CTA variants          | `campaign-content.md` with primary + fallback assets        |
| GATE    | GO/NO-GO decision                     | `campaign-gate.md` with confidence level                    |
| LAUNCH  | Send via channel, verify delivery     | Message ID, delivery confirmation                           |
| ANALYZE | Collect engagement data               | clicks, engagement recorded in weekly-status                |
| LEARN   | Extract reusable lessons              | Append to `campaign-lessons-learned.md`                     |

### Hard Constraints (enforced by skill)

- `channel` must be specified in Phase 2 (blocks progression if missing)
- `recipients` must be specified in Phase 5 (blocks launch if missing)
- Timing window: Tue-Thu 09:00-11:00 UTC+8 for audience-facing content (overridable for self-tests with documented rationale)

## Campaign Templates

### Template 1: Feature Launch

**Goal**: Drive awareness of a new OpenClaw feature
**Duration**: 1 week (Day -1 prep, Day 0 launch, Day +3 follow-up, Day +5 retro)
**Channel**: Telegram DM → group/channel (when D9 resolved)

**Workflow**: Use campaign-lifecycle skill with:

- `scope: effect_validation` (real audience)
- CTA: inline buttons or polls (lesson: low friction)
- Timing: Tue-Thu morning UTC+8 (lesson: developer engagement)
- Tracking: short link required for effect validation (if unavailable: document `no_tracking` + measurement limits)

### Template 2: Process Validation (Self-Test)

**Goal**: Verify campaign infrastructure works end-to-end
**Duration**: Single session
**Channel**: Telegram DM (single recipient)

**Workflow**: Use campaign-lifecycle skill with:

- `scope: process_validation`
- `recipients: single`
- Timing: flexible (override acceptable with documentation)
- Tracking: `no_tracking` acceptable

### Template 3: Educational Content Series

**Goal**: Teach developers how to build with OpenClaw
**Duration**: Bi-weekly recurring
**Channel**: Telegram + docs cross-link

**Content types** (ranked by R4 observation):

1. Copy-paste tutorials with code examples (highest engagement)
2. "Before/After" workflow comparisons
3. Use case showcases with real configs

## Validated Learnings (R4 + R5)

### Strategy & Timing

- Tue-Thu 09-11AM UTC+8 for developer audience
- Timing override acceptable for documented self-tests
- Process validation ≠ effect validation — scope must be declared upfront

### Content & CTA

- Inline buttons > text reply CTAs (low friction)
- Code examples > feature descriptions (3x engagement)
- "Before/After" comparisons resonate strongly

### Measurement

- Short link tracking required for effect validation campaigns
- `no_tracking` acceptable for internal process validation (document the gap)
- Telegram native view counts unreliable for non-admin bots

### Operations

- Record runtime artifacts (message ID, chat ID, CTA variant) for auditability
- Runtime memory ≠ git repo (D11) — sync lessons to repo after each campaign
- Weekly-status must be updated same-day as campaign completion

## Channel Capabilities

| Channel          | Status         | Audience         | Limitation                                                      |
| ---------------- | -------------- | ---------------- | --------------------------------------------------------------- |
| Telegram DM      | Active         | Single recipient | No broadcast                                                    |
| Telegram Group   | Active         | Multi-recipient  | D9 fixed 2026-03-13 (groupAllowFrom added); verified msg_id=315 |
| Telegram Channel | Not configured | Broadcast        | Requires channel creation + bot admin                           |
| Slack            | Deferred (R7)  | Team workspace   | Not connected                                                   |

**R8 prerequisite**: ~~Fix D9~~ Done (2026-03-13). Telegram channel for broadcast: optional (not yet configured).
