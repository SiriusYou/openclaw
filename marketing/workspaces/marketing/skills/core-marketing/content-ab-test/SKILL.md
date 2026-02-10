---
name: content-ab-test
description: Design and track A/B tests for marketing content. Use when comparing message variants, subject lines, CTAs, or creative approaches.
metadata:
  openclaw:
    emoji: "\U0001F9EA"
---

# Content A/B Testing

## Creating a Test

1. Define hypothesis: "Variant B will increase [metric] by [X]% because [reason]"
2. Generate 2-3 variants with a single controlled variable
3. Assign distribution channels (equal split)
4. Set duration and sample size threshold
5. Define success metric

## Recording Results

Update memory with test record:
- Test ID, date, hypothesis
- Variants with descriptions
- Channel, audience segment
- Result: winner, lift percentage, confidence
- Learning: what to apply going forward

## Decision Rules

- Minimum 48 hours runtime before calling winner
- Statistical significance threshold: 95%
- If no clear winner: extend test or declare "no difference"
- Always document learnings regardless of outcome
