# Quick Start Guide

Get MarketClaw Kit running in under 10 minutes.

## Prerequisites

### Node.js 22+

```bash
node -v
# v22.x.x or higher required

# Install via nvm if needed:
nvm install 22
nvm use 22
```

### openssl

```bash
openssl version
# Usually pre-installed on macOS and Linux
```

The OpenClaw CLI is installed automatically by `setup.sh` — no need to install it beforehand.

## Installation

```bash
git clone https://github.com/yourorg/marketclaw-kit.git
cd marketclaw-kit
bash setup.sh
```

### What setup.sh does

1. **Checks prerequisites** — verifies Node 22+ and openssl
2. **Installs OpenClaw CLI** — `npm i -g openclaw@latest` (if not already installed)
3. **Generates .env** — creates a random gateway token
4. **Collects API keys** — prompts for Google and/or OpenRouter keys (at least one chain-compatible key required)
5. **Writes auth profiles** — stores keys in `~/.openclaw/agents/main/agent/auth-profiles.json`
6. **Deploys config** — copies `openclaw.json` with resolved workspace paths to `~/.openclaw/`
7. **Creates workspace** — sets up marketing workspace with skills, memory, and templates
8. **Installs extensions** — deploys marketing-feedback and skill-audit plugins
9. **Installs gateway daemon** — configures and starts the macOS LaunchAgent
10. **Runs health check** — verifies everything is working

### API Keys

The kit uses a two-provider model chain:

- **Primary**: `google/gemini-3-pro-preview` — requires a Google API key
- **Fallback**: `openrouter/auto` — requires an OpenRouter API key

You need at least one of these. Both is recommended for failover.

Get your keys:

- **Google**: [AI Studio](https://aistudio.google.com/apikey)
- **OpenRouter**: [OpenRouter Keys](https://openrouter.ai/keys)
- **OpenAI** (optional): [OpenAI API Keys](https://platform.openai.com/api-keys)

## Verify Installation

```bash
bash scripts/health-check.sh
```

All 5 checks should pass:

1. OpenClaw CLI found and version compatible
2. Gateway running with healthy RPC
3. Chain-compatible auth profile configured
4. Workspace structure complete
5. All 9 core marketing skills present

## First Campaign

Send a message to your Telegram bot:

```
Brainstorm 3 campaign concepts for a one-week campaign about [YOUR_TOPIC].
```

The agent will use the `structured-brainstorm` skill to generate concepts. Continue through the 7-phase lifecycle:

1. **IDEATE** — brainstorm concepts
2. **PLAN** — create campaign brief
3. **CREATE** — draft content + adapt for channels
4. **GATE** — Go/Hold/No-Go decision
5. **LAUNCH** — send via channel
6. **ANALYZE** — collect engagement data
7. **LEARN** — extract reusable lessons

## Add Your First Customer

```bash
cp customers/example.json customers/acme-corp.json
# Edit acme-corp.json with customer details
bash scripts/provision-customer.sh create acme-corp
```

See [Client Onboarding](client-onboarding.md) for the full walkthrough.

## Common Issues

### Gateway won't start

```bash
# Check status
openclaw gateway status --require-rpc

# Run doctor
openclaw doctor --repair

# Manual restart
openclaw daemon restart
```

### Auth profile not found

```bash
# Check auth profiles
cat ~/.openclaw/agents/main/agent/auth-profiles.json

# Re-run setup to add keys
bash setup.sh
```

### Skills not loading

```bash
# Verify skills in workspace
ls ~/.openclaw/workspaces/marketing/skills/core-marketing/

# Check gateway logs for skill filter
grep "skills" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5
```
