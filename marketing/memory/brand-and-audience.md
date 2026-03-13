# OpenClaw Marketing — Brand & Audience Knowledge

## Brand Positioning

**Product**: OpenClaw — open-source AI agent gateway for personal and team use.
**Tagline**: "Your AI agents, your rules."
**Core Value Proposition**: Self-hosted, privacy-first AI agent orchestration that connects multiple LLM providers with messaging channels (Telegram, Slack, Discord, Signal, WhatsApp, and more).

### Key Differentiators (verified from codebase)

- **Open Source**: Full transparency, MIT license, community-driven
- **Multi-Provider Failover**: OpenAI, Google, Anthropic, OpenRouter — automatic failover with cooldown + probe recovery
- **Self-Hosted Gateway**: Local launchd daemon on macOS, data stays on your machine
- **15+ Messaging Channels**: Telegram, Slack, Discord, Signal, WhatsApp, iMessage, Matrix, MS Teams, Line, Feishu, Zalo, and more via extension plugins
- **Agent Workspaces**: Isolated agent contexts with separate skills, memory, and routing
- **Skill Ecosystem**: Core skills + evolved skills + ClawHub marketplace (install with `openclaw skills install`)
- **Self-Evolution**: Agents can create and refine their own skills over time (evolution-semimonthly cron)
- **Cron Scheduling**: Built-in job scheduler with lane management, failure alerting, and health monitoring
- **Plugin Architecture**: Extensions ship as npm packages; enable/disable at runtime
- **Docker Sandboxing**: Optional sandboxed execution for agent tools (sandbox + sandbox-browser)
- **Cross-Platform**: macOS app (Sparkle updates), CLI (`npm i -g openclaw`), mobile (iOS/Android)

### Brand Voice

- Technical but accessible — lead with real commands and configs, not marketing fluff
- Empowering — user control, self-sovereignty, "your data, your rules"
- Community-oriented — open source ethos, contributor spotlights
- Practical — real use cases with real configs, not hypothetical scenarios

## Target Audience

### Primary: Developer-Operators

- Solo developers running AI agents for personal productivity
- Technical founders automating business workflows
- Power users who want control over their AI stack
- Demographics: 25-45, technically proficient, privacy-conscious
- **Pain points**: vendor lock-in, API cost unpredictability, scattered tooling, no unified agent runtime

### Secondary: Small Teams

- Startup teams needing shared AI agents across messaging channels
- Marketing/research teams automating content workflows
- DevOps teams wanting AI-assisted monitoring and alerting

### Tertiary: Open Source Contributors

- Plugin/extension developers
- Skill creators on ClawHub marketplace
- Users who want to customize agent behavior

## Competitor Landscape (updated 2026-03)

| Competitor              | Strengths                               | Weaknesses vs OpenClaw                                                  |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| LangChain/LangGraph     | Mature ecosystem, huge community        | Framework not runtime; no built-in channels; requires custom deployment |
| AutoGPT/AgentGPT        | Brand recognition, easy start           | Cloud-dependent, limited provider choice, no self-hosted option         |
| Botpress                | Visual builder, enterprise features     | Closed source, SaaS pricing, no personal use case                       |
| n8n + AI nodes          | Powerful workflow automation            | Not agent-native, complex setup, no skill evolution                     |
| Custom Telegram bots    | Full control, simple for single-channel | No failover, no multi-channel, no skill ecosystem, maintenance burden   |
| Claude Code / Codex CLI | Deep IDE integration                    | Not a gateway/runtime; no messaging channels; no persistent agents      |

### Unique angles for content

- "One install, 15 channels" — the multi-channel story
- "Your agent evolves" — self-evolution and skill creation
- "Never locked in" — multi-provider failover with automatic recovery
- "$0/month for personal use" — self-hosted cost story vs SaaS alternatives
- "From CLI to Telegram in 5 minutes" — developer experience story

## Messaging Guidelines

- Lead with **control and privacy**, not just "AI"
- Show real `openclaw` CLI commands and config snippets
- Emphasize **cost savings** from multi-provider failover and self-hosting
- Use "Before/After" comparisons (scattered tools → unified gateway)
- Community stories > feature lists
- Never overclaim audience metrics without data
