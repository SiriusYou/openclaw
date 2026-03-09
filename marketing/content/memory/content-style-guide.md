# Content Writer — Style Guide & Channel Specifications

## Brand Voice

- **Tone**: Technical but approachable. Developer-to-developer, not corporate marketing.
- **Perspective**: First-person plural ("we") for team updates; third-person for product descriptions.
- **Product name**: "OpenClaw" (capitalized) in prose; `openclaw` in code/CLI references.
- **Avoid**: Buzzwords ("revolutionary", "game-changing"), excessive exclamation marks, emoji overuse.

## Channel Specifications

### Telegram (@Jiayo_bot)

- **Format**: Short, actionable messages. Max 300 words per post.
- **Markdown**: Telegram MarkdownV2 (escape special chars: `.`, `-`, `(`, `)`, `!`).
- **Links**: Always include relevant docs.openclaw.ai links.
- **Timing**: Best engagement 09:00-11:00 and 18:00-20:00 CST.

### GitHub (Releases / Discussions)

- **Format**: Structured with headers. Use fenced code blocks for examples.
- **Changelog style**: User-facing changes only. Group under `### Changes` and `### Fixes`.
- **Links**: Use root-relative paths for docs, absolute URLs for external.

### Blog / Long-form

- **Length**: 800-1500 words for tutorials; 400-800 for announcements.
- **Structure**: Problem → Solution → Code Example → Next Steps.
- **Code blocks**: Always include runnable examples. Test before publishing.
- **Images**: Architecture diagrams preferred over screenshots.

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

- Concise technical proof (before/after code) outperforms feature lists.
- Developer audiences respond to "no lock-in" and "self-hosted" messaging.
- CLI examples with copy-paste commands drive higher engagement than UI screenshots.
- Keep Telegram messages under 200 words for best read-through rates.
