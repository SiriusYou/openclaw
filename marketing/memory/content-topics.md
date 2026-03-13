# Content Topics Library

Topics ranked by expected developer engagement (based on R4 observation: code examples > feature descriptions).

## Tier 1: High Engagement (tutorial + code)

### "Set up OpenClaw in 5 minutes"

- Install → configure → first Telegram message
- Show: `npm i -g openclaw`, `openclaw setup`, `openclaw gateway run`
- CTA: "Try it and tell us your setup time"

### "Multi-provider failover: never get rate-limited again"

- Configure OpenAI primary + Google fallback + OpenRouter last-resort
- Show: auth-profiles.json + provider config
- Demo: what happens when primary provider goes down (automatic recovery)

### "Build your first custom skill"

- Skill YAML frontmatter + prompt structure
- Install from ClawHub vs create locally
- Show: `openclaw skills install <name>` and skill invocation

### "One bot, 15 channels"

- Connect Telegram + Discord + Slack to same agent
- Show: channel config, routing, per-channel behavior
- Before/After: 3 separate bots → 1 OpenClaw gateway

### "Automate your morning briefing with cron"

- Set up daily summary cron job
- Show: cron config, Telegram delivery, failure alerting
- Real example: cost-daily and gateway-health patterns

## Tier 2: Medium Engagement (explainer + config)

### "Agent workspaces: isolate your AI contexts"

- Separate agents for marketing, ops, personal
- Show: workspace config, SOUL.md, per-agent routing
- Use case: marketing agent with content skills vs ops agent with monitoring

### "Self-evolving agents: let your bot write its own skills"

- Evolution cron loop + ClawHub integration
- Show: evolution-semimonthly output, evolved skill examples
- Caution: prompt-level dedup, not magic

### "Docker sandboxing: safe agent execution"

- Sandbox vs sandbox-browser containers
- When to use (untrusted inputs) vs skip (cron jobs need network)
- Show: sandbox config toggle

### "Campaign lifecycle: 7-phase marketing automation"

- IDEATE→PLAN→CREATE→GATE→LAUNCH→ANALYZE→LEARN
- Show: skill structure, hard constraints (channel, recipients)
- Lessons from R4+R5

### "Cost monitoring: keep your AI spend at $0"

- Subscription-based providers vs API key providers
- Cost-daily cron + 3-tier alerting (NORMAL/WARNING/CRITICAL)
- Show: real cost report output

## Tier 3: Thought Leadership (narrative)

### "Why self-hosted AI agents matter in 2026"

- Privacy, cost, control, customization
- Contrast with SaaS AI agent platforms
- Open source community angle

### "The plugin architecture: extending OpenClaw"

- How extensions work (npm packages, runtime enable/disable)
- Writing a channel plugin vs a skill plugin
- ClawHub marketplace ecosystem

### "From side project to production: hardening your agent"

- Backup, log rotation, health monitoring, smoke tests
- Lessons from our own production hardening (N7)
- Checklist format

## Content Format Guidelines (from R4+R5)

- **Telegram DM**: Short (< 300 words), one CTA, inline buttons preferred
- **Telegram Group**: Concise post + discussion prompt
- **Blog/docs**: Long-form tutorial with copy-paste commands
- **GitHub**: Release notes style, link to docs
- Code examples always in fenced blocks with language tag
- "Before/After" framing when showing value proposition
