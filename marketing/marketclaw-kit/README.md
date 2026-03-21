# MarketClaw Kit

Multi-client AI marketing agent platform built on [OpenClaw](https://github.com/openclaw/openclaw).

Each customer gets an isolated gateway instance with independent config, workspace, Telegram bot, and API keys. The operator manages all instances from a single machine.

## Prerequisites

- **Node.js 22+** (`node -v`)
- **openssl** (for token generation)

The OpenClaw CLI is installed automatically by `setup.sh`.

## Quick Start

```bash
git clone https://github.com/yourorg/marketclaw-kit.git
cd marketclaw-kit
bash setup.sh
```

`setup.sh` will:

1. Check prerequisites (Node 22+, openssl)
2. Install OpenClaw CLI (`npm i -g openclaw@latest`)
3. Generate gateway token
4. Collect API keys (Google and/or OpenRouter required)
5. Deploy config and workspace
6. Install extensions (marketing-feedback, skill-audit)
7. Install and start the gateway daemon
8. Run health check

## Multi-Client Management

Each customer = one independent gateway instance, isolated by `--profile`.

```bash
# Create a customer
cp customers/example.json customers/acme-corp.json
# Edit acme-corp.json: set customerId, brandName, audience, port, reporting
bash scripts/provision-customer.sh create acme-corp

# Add Telegram bot + API keys
openclaw --profile acme-corp channels add --channel telegram --token '<BOT_TOKEN>'
# API keys are written during provisioning or via the auth script in setup.sh

# Lifecycle management
bash scripts/provision-customer.sh pause acme-corp
bash scripts/provision-customer.sh resume acme-corp
bash scripts/provision-customer.sh status acme-corp
bash scripts/provision-customer.sh export acme-corp
bash scripts/provision-customer.sh destroy acme-corp

# Check all customers
bash scripts/customer-status.sh
```

## Directory Structure

```
marketclaw-kit/
├── setup.sh                    # One-click bootstrap
├── openclaw.json               # Gateway config template (__WORKSPACE_ROOT__ placeholder)
├── customers/                  # Customer manifests
│   ├── example.json            # Template manifest
│   └── README.md               # Onboarding checklist
├── scripts/                    # Operational scripts
│   ├── provision-customer.sh   # Customer lifecycle management
│   ├── customer-status.sh      # Multi-customer status dashboard
│   ├── configure-customer-crons.sh  # Per-customer cron setup
│   ├── health-check.sh         # Post-install verification
│   ├── pre-package-scan.sh     # Secret leak scanner
│   ├── daily-backup.sh         # Automated backup
│   ├── log-rotate.sh           # Log cleanup (14-day retention)
│   ├── upgrade-cli.sh          # CLI version upgrade
│   └── cron-health-check.sh    # Cron job health monitoring
├── workspaces/marketing/       # Agent workspace template
│   ├── AGENTS.md               # Task execution rules
│   ├── SOUL.md                 # Agent persona
│   ├── HEARTBEAT.md            # Health check standing orders
│   ├── MEMORY.md               # Strategy knowledge base
│   └── skills/core-marketing/  # 9 marketing skills
├── memory/                     # Knowledge base templates
├── strategies/                 # Campaign playbook
├── performance/                # Baseline metrics template
├── content/memory/             # Content style guide template
├── analytics/memory/           # Market research template
├── extensions/                 # Plugin extensions
│   ├── marketing-feedback/     # Feedback collection plugin
│   └── skill-audit/            # Skill safety audit plugin
└── docs/                       # Documentation
    ├── quick-start.md          # Detailed setup guide
    ├── client-onboarding.md    # Customer onboarding walkthrough
    └── architecture.md         # System architecture overview
```

## Skills (9 core marketing skills)

| Skill                    | Campaign Phase | Purpose                             |
| ------------------------ | -------------- | ----------------------------------- |
| `structured-brainstorm`  | IDEATE         | Generate campaign concepts          |
| `campaign-brief`         | PLAN           | Define brief with constraints       |
| `content-ab-test`        | CREATE         | Draft content variants              |
| `content-repurposing`    | CREATE         | Adapt content for multiple channels |
| `campaign-decision-gate` | GATE           | Go/Hold/No-Go decision              |
| `campaign-lifecycle`     | All            | 7-phase orchestrator                |
| `weekly-summary`         | ANALYZE        | Weekly performance snapshot         |
| `campaign-retrospective` | LEARN          | Extract lessons learned             |
| `campaign-diagnosis`     | Any            | Diagnose campaign issues            |

## Security Model

- **Sandbox**: Off (customers interact via Telegram, skills are operator-curated)
- **Exec**: Denied (no arbitrary shell execution)
- **Filesystem**: Workspace-only (agents restricted to their workspace)
- **API keys**: Stored in auth-profiles.json per profile, never in config or env files
- **Zero secrets in repo**: `pre-package-scan.sh` enforces this

## Documentation

- [Quick Start Guide](docs/quick-start.md) — Detailed setup walkthrough
- [Client Onboarding](docs/client-onboarding.md) — Step-by-step customer setup
- [Architecture](docs/architecture.md) — System design and security model

## Optional Enhancements (post-install)

- **ClawHub skills**: `openclaw skills install <name>` for additional capabilities
- **Subagents**: Add content-writer or analyst agents for specialized workflows
- **Docker sandbox**: Enable `sandbox.mode: "all"` for untrusted execution contexts
