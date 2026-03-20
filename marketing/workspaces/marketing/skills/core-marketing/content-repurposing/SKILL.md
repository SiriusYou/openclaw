---
name: content-repurposing
description: Adapt primary campaign content for multiple distribution channels while preserving core message and brand voice. Use after content creation when distributing across Telegram, Twitter, blog, etc.
metadata:
  openclaw:
    emoji: "\U0001F504"
---

# Content Repurposing

## Purpose

Take a primary content asset (blog post, announcement, landing page copy) and adapt it for each distribution channel specified in the campaign brief, preserving the core message and CTA while matching channel-specific format and tone constraints.

## When to Use

- After primary content is drafted (Phase 3 CREATE of campaign-lifecycle)
- When a campaign brief specifies multiple distribution channels
- When repurposing existing content for a new channel

## Safety Boundaries

- Do not invent claims or statistics not present in the primary asset
- Do not change the core CTA — adapt its phrasing, not its intent
- Do not exceed channel character/format limits (flag if primary content is too long to adapt)
- Preserve all required disclaimers or compliance language from the original

## Required Retrieval Steps

1. `memory_search('brand voice')` — load tone and style guidelines
2. `memory_search('<campaign-name> brief')` — load channel list and audience segments

## Step-by-Step Procedure

1. **Identify primary asset**: read the source content (blog post, announcement, etc.)
2. **List target channels**: extract channels from the campaign brief
3. **For each channel**, adapt the content:
   - **Telegram**: concise message (under 4096 chars), use markdown formatting, include CTA link
   - **Twitter/X**: thread format if needed (280 chars/tweet), hook in first tweet, CTA in last
   - **Blog/Landing page**: full-length, SEO-friendly headings, structured with H2/H3
   - **Email**: subject line + preview text + body, clear CTA button text
   - **Other**: match the channel's known constraints (ask operator if unknown)
4. **Review each adaptation** against brand voice guidelines
5. **Flag any gaps**: if a channel requires assets not available (e.g. images, video), note what's missing

## Output Format Template

```markdown
# Content Repurposing: <Campaign Name>

## Primary Asset

- **Type**: <blog post / announcement / etc.>
- **Core Message**: <1 sentence>
- **CTA**: <call to action>

## Channel Adaptations

| Channel   | Format         | Length   | CTA Variant            | Status |
| --------- | -------------- | -------- | ---------------------- | ------ |
| Telegram  | Markdown msg   | 850 char | "Read more: <link>"    | Ready  |
| Twitter/X | 3-tweet thread | 840 char | "Check it out: <link>" | Ready  |
| Blog      | Full article   | 1200 wrd | "Get started: <link>"  | Ready  |

### Telegram

<adapted content>

### Twitter/X

<adapted content>

### Blog

<adapted content>

## Missing Assets

- <list any assets needed but not available>
```

## Quality Checklist

- [ ] Core message preserved in every adaptation
- [ ] CTA present and actionable in each channel version
- [ ] Brand voice consistent across all adaptations
- [ ] Channel format constraints respected (character limits, markdown support)
- [ ] No fabricated claims or statistics added during adaptation
- [ ] Missing assets flagged (not silently omitted)
