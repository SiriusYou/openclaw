---
name: campaign-diagnosis
description: Use when a campaign is underperforming or showing unexpected metrics. Systematic root cause analysis for marketing problems.
metadata:
  openclaw:
    emoji: "\U0001F50D"
---

# Campaign Diagnosis

## Step 1: Gather Evidence

- Pull performance data from memory: `memory_search("campaign [name] performance")`
- Compare against baseline/historical average
- Identify which specific metrics deviate (impressions, CTR, conversion, etc.)

## Step 2: Hypothesize (generate 3+ hypotheses)

Common root causes:
- **Audience**: targeting too broad/narrow, audience fatigue
- **Creative**: message-market mismatch, worn-out creative
- **Channel**: algorithm changes, competition surge, timing
- **Technical**: tracking broken, landing page issues, load time
- **External**: seasonality, news cycle, competitor moves

## Step 3: Test Each Hypothesis

For each hypothesis:
1. What data would confirm or reject it?
2. Check that data (memory, analytics, web search)
3. Rate confidence: HIGH / MEDIUM / LOW

## Step 4: Recommend Action

- Present root cause with evidence
- Propose fix with expected timeline and effort
- Suggest A/B test to validate fix before full rollout
- Document findings in memory for future reference
