# Campaign Lessons Learned

## Validated Lessons

### Strategy & Timing

- **If targeting developers, then launch Tue-Thu mornings (09:00-11:00 local time).**
  - _Source_: OpenClaw Pilot 1 (2026-03-07)
  - _Context_: Weekend/Late night launches resulted in <20% estimated read rate.
- **If the campaign goal is process validation rather than effect validation, then a controlled timing override is acceptable when explicitly documented with scope and approver.**
  - _Source_: R5 Telegram DM Process Validation (2026-03-13)
  - _Context_: Friday launch outside the normal Tue-Thu window was acceptable because the operator explicitly waived the rule for a single-recipient self-test.

### Content & Creative

- **If asking for initial engagement, then use low-friction CTAs (Polls/Buttons).**
  - _Source_: OpenClaw Pilot 1 (2026-03-07)
  - _Context_: "Reply with a command" text CTA had high friction and low conversion.
- **If running a single-recipient Telegram DM self-test, then inline buttons are a reliable first-choice CTA for validating both render and interaction paths.**
  - _Source_: R5 Telegram DM Process Validation (2026-03-13)
  - _Context_: Both button paths were confirmed by the operator.
- **If a round is process-validation only, then do not infer marketing effectiveness from successful operator interaction.**
  - _Source_: R5 Telegram DM Process Validation (2026-03-13)
  - _Context_: One recipient and confirmed clicks validate workflow, not audience performance.

### Measurement

- **If running a pilot on Telegram, then ensure admin tools or link tracking are active.**
  - _Source_: OpenClaw Pilot 1 (2026-03-07)
  - _Context_: Native "View" counts are unreliable for non-admin bots.
- **If link tracking is unavailable but the round is informational and internal, then log `no_tracking` before launch and treat it as an instrumentation gap, not a blocker.**
  - _Source_: R5 Telegram DM Process Validation (2026-03-13)
  - _Context_: Short.io was not configured, but the internal self-test still proceeded with the gap documented.

### Operations & Auditability

- **If validating channel operations, then record runtime artifacts (chat ID, message ID, CTA variant, confirmations, and commit history) so the run is auditable end-to-end.**
  - _Source_: R5 Telegram DM Process Validation (2026-03-13)
  - _Context_: The lifecycle was reconstructable from recorded message metadata, confirmations, memory files, and git commits.
- **If validating Telegram multi-surface operations, then test DM and Group in the same controlled round to confirm both delivery paths together.**
  - _Source_: R8 Multi-Channel Telegram Process Validation (2026-03-13)
  - _Context_: A single round verified successful sends and CTA interaction handling across both Telegram surfaces.
- **If using Telegram inline buttons, then each button must include both visible text and `callback_data`.**
  - _Source_: R8 Multi-Channel Telegram Process Validation (2026-03-13)
  - _Context_: Successful CTA handling depended on the correct text + callback payload pairing.
- **If a Telegram Group send succeeds after an infrastructure fix, then treat it as process validation evidence, not audience validation evidence.**
  - _Source_: R8 Multi-Channel Telegram Process Validation (2026-03-13)
  - _Context_: The D9-fix follow-up confirmed group delivery readiness, but the tiny audience and off-window timing prevented effect claims.
