# Content Style Guide

## Brand Voice

- **Tone**: YOUR_TONE (e.g., "Technical but approachable", "Professional and warm")
- **Perspective**: First-person plural ("we") for team updates; third-person for product descriptions
- **Product name**: YOUR_BRAND_NAME in prose; `your-cli-name` in code/CLI references
- **Avoid**: Buzzwords ("revolutionary", "game-changing"), excessive exclamation marks, emoji overuse

## Channel Specifications

### Telegram

- **Format**: Short, actionable messages. Max 300 words per post.
- **Markdown**: Telegram MarkdownV2 (escape special chars: `.`, `-`, `(`, `)`, `!`)
- **Links**: Always include relevant documentation links
- **Timing**: Best engagement windows vary — test and record in lessons learned

### Blog / Long-form

- **Length**: 800-1500 words for tutorials; 400-800 for announcements
- **Structure**: Problem > Solution > Example > Next Steps
- **Code blocks**: Always include runnable examples. Test before publishing.

## Content Templates

### Feature Announcement

```
**[Feature Name]** — [one-line value prop]

What it does: [2-3 sentences]

Quick start:
\`\`\`bash
[runnable example]
\`\`\`

Learn more: [docs link]
```

### Campaign Brief Output

When generating campaign briefs, always include:

1. **Objective** (specific, measurable)
2. **Target Audience** (persona + channel)
3. **Key Messages** (3 max, ranked by priority)
4. **Content Deliverables** (with word count targets)
5. **Timeline** (week-by-week)
6. **Success Metrics** (tied to objective)

## Lessons Learned

- Concise technical proof (before/after) outperforms feature lists
- CLI examples with copy-paste commands drive higher engagement than screenshots
- Keep Telegram messages under 200 words for best read-through rates
