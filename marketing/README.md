# OpenClaw Marketing Agent System

Self-evolving automated marketing agent system built on OpenClaw.

## Quick Start

```bash
# 1. Make setup script executable
chmod +x setup.sh

# 2. Run bootstrap (checks prereqs, builds images, creates dirs, generates .env)
./setup.sh

# 3. Edit .env with your API keys
vi .env

# 4. Re-run setup to start services
./setup.sh
```

## File Structure

```
marketing/
├── setup.sh                          # One-click bootstrap script
├── docker-compose.marketing.yml      # Docker Compose services
├── openclaw.json                     # OpenClaw configuration template
├── .env.example                      # Environment variables template
├── workspaces/
│   ├── marketing/                    # Orchestrator workspace
│   │   ├── MEMORY.md                 # Strategy knowledge base
│   │   └── skills/core-marketing/    # Custom marketing skills
│   ├── content/                      # Content Writer workspace
│   │   └── MEMORY.md
│   └── analytics/                    # Analyst workspace
│       └── MEMORY.md
└── extensions/
    ├── marketing-feedback/           # Feedback collection plugin
    └── skill-audit/                  # Security audit plugin
```

## Architecture

- **Marketing Orchestrator** (`openai-codex/gpt-5.3-codex`): Task routing, strategy, skill evolution
- **Content Writer** (`openai-codex/gpt-5.3-codex`): Copy generation, A/B testing, content calendar
- **Marketing Analyst** (`google/gemini-3-pro-preview`, fallback `openrouter/auto`): Deep analysis, competitive intel, browser automation

See `MARKETING_AGENT_SYSTEM_PLAN.md` for the full 9-phase implementation plan.
