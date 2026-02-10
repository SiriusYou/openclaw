# Self-Evolving Marketing Agent System — Implementation Plan

> Based on OpenClaw v2026.2.6-3 | Target: Production-ready in 9 weeks

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Phase 0: Container Strategy & Environment (Week 1)](#phase-0-container-strategy--environment-week-1)
- [Phase 1: Core Agent Setup (Week 1-2)](#phase-1-core-agent-setup-week-1-2)
- [Phase 2: Skill Ecosystem Integration (Week 2-3)](#phase-2-skill-ecosystem-integration-week-2-3)
- [Phase 3: Knowledge Ingestion Pipeline (Week 3-4)](#phase-3-knowledge-ingestion-pipeline-week-3-4)
- [Phase 4: Self-Evolution Loop (Week 4-5)](#phase-4-self-evolution-loop-week-4-5)
- [Phase 5: Observability & Cost Control (Week 5-6)](#phase-5-observability--cost-control-week-5-6)
- [Phase 6: Browser Automation & Competitive Intelligence (Week 6-7)](#phase-6-browser-automation--competitive-intelligence-week-6-7)
- [Phase 7: Production Hardening (Week 7-8)](#phase-7-production-hardening-week-7-8)
- [Phase 8: Production Deployment & Scaling (Week 8-9)](#phase-8-production-deployment--scaling-week-8-9)
- [Appendix A: Security Checklist](#appendix-a-security-checklist)
- [Appendix B: Configuration Reference](#appendix-b-configuration-reference)
- [Appendix C: Risk Register](#appendix-c-risk-register)
- [Appendix D: Container Decision Matrix](#appendix-d-container-decision-matrix)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        KNOWLEDGE SUPPLY                          │
│                                                                  │
│  skill_seekers ──► skill-from-masters ──► ClawHub / skills.sh   │
│  (ingest)          (distill)              (distribute)           │
│                                                                  │
│  Sources: competitor docs, marketing blogs, industry reports,    │
│           campaign post-mortems, session transcripts             │
└──────────────────────────┬───────────────────────────────────────┘
                           │ SKILL.md
┌──────────────────────────▼───────────────────────────────────────┐
│                       AGENT EXECUTION                            │
│                                                                  │
│  ┌─────────────────┐  ┌───────────────┐  ┌─────────────────┐   │
│  │  Orchestrator   │─►│ Content       │  │ Analyst         │   │
│  │  (Sonnet 4.5)   │  │ Writer        │  │ (Opus 4.6)      │   │
│  │  task routing    │  │ (Sonnet 4.5)  │  │ deep analysis   │   │
│  │  strategy        │  │ copy / posts  │  │ data / trends   │   │
│  └────────┬────────┘  └───────────────┘  └────────┬────────┘   │
│           │                                        │             │
│           │          Browser Automation ◄───────────┘             │
│           │          (competitive intel / SEO / screenshots)     │
└───────────┼──────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────┐
│                     CHANNEL DISTRIBUTION                         │
│                                                                  │
│  Slack (internal)  │  Telegram  │  WhatsApp  │  Discord  │ Email│
│                                                                  │
│  ◄── send policy: staged permissions ──►                         │
└───────────┬──────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────┐
│                    FEEDBACK & EVOLUTION                           │
│                                                                  │
│  Diagnostics ──► Transcripts ──► Memory (SQLite+FTS+Vector)     │
│  (tokens/cost/    (JSONL)        (searchable experience DB)      │
│   latency/tools)                                                 │
│        │                                                         │
│        ▼                                                         │
│  Cron Reflection ──► Strategy Update ──► Skill Create/Refine    │
│  (weekly/daily)      (MEMORY.md)        (skills/evolved/)        │
└──────────────────────────────────────────────────────────────────┘
```

### Container Deployment Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Docker Compose Cluster                        │
│                                                                  │
│  ┌──────────────────┐  ┌────────────────────┐                   │
│  │ openclaw-gateway │  │ sandbox-browser    │                   │
│  │ node:22-bookworm │  │ debian:bookworm    │                   │
│  │ USER: node       │  │ USER: sandbox      │                   │
│  │ Port: 18789      │  │ Chromium + noVNC   │                   │
│  │ (loopback only)  │  │ Port: 9222/6080    │                   │
│  │ read_only: true  │  │ read_only: true    │                   │
│  │ cap_drop: ALL    │  │ cap_drop: ALL      │                   │
│  └────────┬─────────┘  └────────────────────┘                   │
│           │                                                      │
│  ┌────────▼─────────┐  ┌────────────────────┐                   │
│  │ sandbox          │  │ skill-seekers      │                   │
│  │ debian:slim      │  │ python:3.12-slim   │                   │
│  │ USER: sandbox    │  │ MCP server (stdio) │                   │
│  │ Tool execution   │  │ Knowledge ingest   │                   │
│  └──────────────────┘  └────────────────────┘                   │
│                                                                  │
│  Volumes: openclaw-config / openclaw-workspaces / openclaw-data  │
│                                                                  │
│  Optional: ── Tailscale sidecar (team access) ──                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Container Strategy & Environment (Week 1)

### 0.1 Container Platform Selection

OpenClaw provides 3 container images + 3 deployment targets out of the box:

| Container | Base Image | Size | Purpose |
|-----------|-----------|------|---------|
| `Dockerfile` | node:22-bookworm | ~1.5GB | Production Gateway (main process) |
| `Dockerfile.sandbox` | debian:bookworm-slim | ~200MB | Agent tool execution isolation |
| `Dockerfile.sandbox-browser` | debian:bookworm-slim | ~800MB | Browser automation (Chromium + noVNC) |

| Deployment Target | Config File | Public Exposure | Best For |
|-------------------|------------|-----------------|----------|
| Docker Compose (local) | `docker-compose.yml` | No (loopback) | Development & single-server |
| Fly.io (public) | `fly.toml` | Yes (HTTPS) | Public-facing with auto-TLS |
| Fly.io (private) | `fly.private.toml` | No | Outbound-only, hidden from scanners |
| Render.com | `render.yaml` | Yes | Quick deploy, starter plan |

#### Recommended: Staged Container Evolution

```
Week 1-6                 Week 6+                   Production
Docker Compose     →     + Tailscale         →     Fly.io (private)
(local single box)       (team remote access)      (7x24, auto-restart)
```

**Decision rationale:**

| Criteria | Docker Compose | + Tailscale | Fly.io Private | Kubernetes |
|----------|---------------|-------------|----------------|------------|
| Complexity | Low | Low-Medium | Medium | High |
| Security | High (loopback) | Very High (WireGuard) | High (no public IP) | High |
| Availability | Single machine | Single + remote | Cloud 7x24 | Multi-node |
| Scalability | None | None | Limited | Strong |
| Cost | $0 | $0 | ~$10-30/mo | High |
| OpenClaw support | Native | Native (`--bind tailnet`) | Native (fly.toml) | No Helm charts |
| **Recommendation** | **Start here** | **Team phase** | **Production** | **Not recommended** |

### 0.2 Build Container Images

```bash
cd /home/user/openclaw

# 1. Build main gateway image
docker build -t openclaw:local .

# 2. Build tool execution sandbox
docker build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .

# 3. Build browser sandbox (for competitive intel)
docker build -t openclaw-sandbox-browser:bookworm-slim -f Dockerfile.sandbox-browser .

# Verify images
docker images | grep openclaw
```

### 0.3 Workspace Directory Structure

```bash
mkdir -p workspaces/marketing/{skills/{meta,core-marketing,platform,evolved},memory,performance,strategies}
mkdir -p workspaces/content/{skills,memory}
mkdir -p workspaces/analytics/{skills,memory}
```

Target layout:

```
workspaces/
├── marketing/                         # Orchestrator workspace
│   ├── MEMORY.md                      # Master strategy document
│   ├── skills/
│   │   ├── meta/                      # Meta-skills (permanent)
│   │   │   ├── skill-from-masters/
│   │   │   ├── search-skill/
│   │   │   ├── skill-from-notebook/
│   │   │   └── skill-from-github/
│   │   ├── core-marketing/            # Curated from ClawHub
│   │   │   ├── email-campaign/
│   │   │   ├── social-scheduler/
│   │   │   ├── seo-analyzer/
│   │   │   ├── ab-testing/
│   │   │   └── content-calendar/
│   │   ├── platform/                  # API integrations
│   │   │   ├── hubspot-api/
│   │   │   ├── google-analytics/
│   │   │   └── meta-ads/
│   │   └── evolved/                   # Agent-created (git-tracked)
│   │       └── .gitkeep
│   ├── memory/                        # Supplementary knowledge
│   ├── performance/                   # Skill effectiveness logs
│   └── strategies/                    # Campaign strategy docs
│
├── content/                           # Content Writer workspace
│   ├── MEMORY.md
│   ├── skills/
│   └── memory/
│
└── analytics/                         # Analyst workspace
    ├── MEMORY.md
    ├── skills/
    └── memory/
```

### 0.4 Security Baseline Configuration

Create `~/.openclaw/config.json5`:

```json5
{
  // --- Gateway Security ---
  gateway: {
    bind: "loopback",                    // NEVER "lan" or "0.0.0.0" unless Tailscale
    port: 18789,
    token: "${OPENCLAW_GATEWAY_TOKEN}",  // openssl rand -hex 32
    trustedProxies: [],
    tls: {
      enabled: false,                    // Enable when remote access needed
    },
  },

  // --- Logging & Diagnostics ---
  logging: {
    level: "info",
    redactSensitive: true,               // Prevent API key leaks in logs
  },
  diagnostics: {
    enabled: true,
    flags: ["gateway.*", "session.*", "webhook.*"],
  },

  // --- Environment ---
  env: {
    vars: {
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
    },
  },

  // --- Agents (see Phase 1) ---
  agents: {},

  // --- Memory ---
  memory: {
    backend: "builtin",
    citations: "auto",
  },

  // --- Session Send Policy (default-deny external) ---
  session: {
    sendPolicy: {
      default: "deny",
      rules: [
        { action: "allow", match: { channel: "slack", chatType: "group" } },
        // Unlock more channels in Phase 7
      ],
    },
  },
}
```

### 0.5 Environment Variables

Create `.env` for Docker Compose:

```bash
# LLM Providers
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Gateway
OPENCLAW_GATEWAY_TOKEN=<openssl rand -hex 32>
OPENCLAW_GATEWAY_BIND=loopback

# Paths
OPENCLAW_CONFIG_DIR=~/.openclaw
OPENCLAW_WORKSPACE_DIR=./workspaces

# Diagnostics
OPENCLAW_DIAGNOSTICS=1

# Marketing Platform APIs (Phase 2+)
# HUBSPOT_API_KEY=...
# GOOGLE_ANALYTICS_KEY=...
# META_ADS_TOKEN=...
```

### 0.6 Docker Compose — Development Setup

Create `docker-compose.marketing.yml`:

```yaml
services:
  # --- Core Gateway ---
  openclaw-gateway:
    image: openclaw:local
    restart: unless-stopped
    init: true
    environment:
      HOME: /home/node
      NODE_ENV: production
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}:18789"
    command:
      - node
      - openclaw.mjs
      - gateway
      - --bind
      - ${OPENCLAW_GATEWAY_BIND:-loopback}
      - --port
      - "18789"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:18789/health')"]
      interval: 30s
      timeout: 5s
      retries: 3

  # --- Interactive CLI ---
  openclaw-cli:
    image: openclaw:local
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      BROWSER: echo
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    stdin_open: true
    tty: true
    init: true
    entrypoint: ["node", "openclaw.mjs"]
    profiles: ["cli"]                    # Only start on demand

  # --- Tool Execution Sandbox ---
  sandbox:
    image: openclaw-sandbox:bookworm-slim
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:noexec,nosuid,size=128m

  # --- Browser Sandbox (competitive intel / SEO) ---
  sandbox-browser:
    image: openclaw-sandbox-browser:bookworm-slim
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    environment:
      OPENCLAW_BROWSER_CDP_PORT: 9222
      OPENCLAW_BROWSER_HEADLESS: 0
      OPENCLAW_BROWSER_ENABLE_NOVNC: 1
    ports:
      - "127.0.0.1:9222:9222"           # CDP (agent connects here)
      - "127.0.0.1:6080:6080"           # noVNC (human observation)
    tmpfs:
      - /tmp:noexec,nosuid,size=512m

  # --- Knowledge Ingestion (on-demand) ---
  skill-seekers:
    image: python:3.12-slim
    volumes:
      - ${OPENCLAW_WORKSPACE_DIR}:/workspaces
    working_dir: /opt/skill_seekers
    command: ["python", "-m", "skill_seekers.mcp.server_fastmcp"]
    profiles: ["ingest"]                 # Only start on demand

volumes:
  openclaw-config:
  openclaw-workspaces:
```

### 0.7 Container Security Hardening

| Parameter | Effect | Applied To |
|-----------|--------|-----------|
| `read_only: true` | Filesystem immutable, prevents malicious writes | sandbox, browser |
| `cap_drop: ALL` | Remove all Linux capabilities, prevents escape | All containers |
| `tmpfs` + `noexec` | Temp dir cannot execute binaries | All containers |
| `127.0.0.1:port` | Ports only reachable from host | gateway, browser |
| `init: true` | Proper PID 1 signal handling (graceful shutdown) | gateway, cli |
| `USER node/sandbox` | Non-root execution | All (built into images) |
| `healthcheck` | Auto-detect gateway failures | gateway |
| `profiles: ["cli"]` | CLI container doesn't auto-start | cli, ingest |

### 0.8 Start & Verify

```bash
# Start core services (gateway + sandboxes)
docker compose -f docker-compose.marketing.yml up -d

# Verify gateway health
curl -s http://127.0.0.1:18789/health

# Run CLI interactively
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli agent \
  --id marketing-orchestrator \
  --message "Hello, confirm you are running inside Docker"

# View browser sandbox via noVNC
open http://127.0.0.1:6080

# Start skill-seekers on demand
docker compose -f docker-compose.marketing.yml --profile ingest up -d skill-seekers
```

### 0.9 Git Init for Evolved Skills

```bash
cd workspaces/marketing/skills/evolved
git init
echo "# Evolved Skills\nAgent-generated skills. Review before merge." > README.md
git add . && git commit -m "init evolved skills repo"
```

**Deliverables:**
- [ ] 3 Docker images built (gateway, sandbox, sandbox-browser)
- [ ] `docker-compose.marketing.yml` created and tested
- [ ] Workspace directories created
- [ ] Security config applied (loopback, token, redact, read_only, cap_drop)
- [ ] Environment variables set in `.env`
- [ ] Gateway health check passing
- [ ] noVNC browser sandbox accessible
- [ ] Evolved skills directory under git

---

## Phase 1: Core Agent Setup (Week 1-2)

### 1.1 Agent Definitions

Add to `~/.openclaw/config.json5`:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "claude-sonnet-4-5-20250929",
        fallbacks: ["claude-opus-4-6"],
      },
    },

    list: [
      // --- Marketing Orchestrator ---
      {
        id: "marketing-orchestrator",
        default: true,
        name: "Marketing Orchestrator",
        workspace: "./workspaces/marketing",
        model: {
          primary: "claude-sonnet-4-5-20250929",
          fallbacks: ["claude-opus-4-6"],
        },
        skills: [
          "clawhub",
          "skill-from-masters",
          "search-skill",
          "skill-from-notebook",
        ],
        subagents: {
          allowAgents: ["content-writer", "analyst"],
          model: "claude-sonnet-4-5-20250929",
        },
        tools: {
          policy: "allowlist",
          allowlist: [
            "memory_search",
            "memory_get",
            "sessions_spawn",
            "clawhub",
            "group:web",
          ],
        },
        memorySearch: { enabled: true },
        groupChat: {
          requireMention: true,
          toolPolicy: "mention",
        },
      },

      // --- Content Writer ---
      {
        id: "content-writer",
        name: "Content Writer",
        workspace: "./workspaces/content",
        model: "claude-sonnet-4-5-20250929",
        skills: ["content-calendar", "seo-analyzer"],
        tools: {
          policy: "allowlist",
          allowlist: [
            "memory_search",
            "memory_get",
            "group:web",
          ],
        },
        memorySearch: { enabled: true },
      },

      // --- Analyst ---
      {
        id: "analyst",
        name: "Marketing Analyst",
        workspace: "./workspaces/analytics",
        model: {
          primary: "claude-opus-4-6",
          fallbacks: ["claude-sonnet-4-5-20250929"],
        },
        skills: ["campaign-analytics"],
        tools: {
          policy: "allowlist",
          allowlist: [
            "memory_search",
            "memory_get",
            "browser_screenshot",
            "browser_navigate",
            "browser_snapshot",
            "group:web",
          ],
        },
        memorySearch: { enabled: true },
        sandbox: {
          mode: "all",
          workspaceAccess: "ro",
          docker: {
            image: "openclaw-sandbox-browser:bookworm-slim",
          },
          browser: {
            enabled: true,
            headless: true,
          },
        },
      },
    ],
  },
}
```

### 1.2 Channel Bindings (Routing Rules)

```json5
{
  bindings: [
    // Slack internal -> Orchestrator
    {
      agentId: "marketing-orchestrator",
      match: { channel: "slack", accountId: "*" },
    },
    // Telegram -> Content Writer (content review channel)
    {
      agentId: "content-writer",
      match: {
        channel: "telegram",
        peer: { kind: "group", id: "CONTENT_REVIEW_GROUP_ID" },
      },
    },
    // Discord analytics channel -> Analyst
    {
      agentId: "analyst",
      match: {
        channel: "discord",
        guildId: "ANALYTICS_GUILD_ID",
      },
    },
  ],
}
```

### 1.3 Initial Channel Setup (Slack First)

```bash
# Via Docker CLI container
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli onboard

# Or configure Slack directly
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli channels add slack
```

Slack config in `config.json5`:

```json5
{
  channels: {
    slack: {
      accounts: [
        {
          label: "marketing-team",
          botToken: "${SLACK_BOT_TOKEN}",
          appToken: "${SLACK_APP_TOKEN}",
          dmPolicy: "pairing",
          groupPolicy: "mention-gating",
        },
      ],
    },
  },
}
```

### 1.4 Seed MEMORY.md

Create `workspaces/marketing/MEMORY.md`:

```markdown
# Marketing Strategy Knowledge Base

## Current Objectives
- [To be filled after first strategy session]

## Brand Voice Guidelines
- [Import from existing brand docs]

## Target Audiences
- [Define personas]

## Active Campaigns
| Campaign | Channel | Status | Start | KPIs |
|----------|---------|--------|-------|------|

## Lessons Learned
| Date | Campaign | What Worked | What Didn't | Action |
|------|----------|-------------|-------------|--------|

## Skill Effectiveness
| Skill | Uses | Success Rate | Notes |
|-------|------|-------------|-------|

## Competitor Intelligence
| Competitor | Last Checked | Key Changes | Our Response |
|------------|-------------|-------------|-------------|
```

### 1.5 Validation

```bash
# All commands via Docker CLI container
COMPOSE="docker compose -f docker-compose.marketing.yml run --rm openclaw-cli"

# Verify agent configuration
$COMPOSE doctor

# List configured agents
$COMPOSE agents list

# Test Orchestrator
$COMPOSE agent --id marketing-orchestrator \
  --message "List your available skills and confirm workspace access"

# Test sub-agent delegation
$COMPOSE agent --id marketing-orchestrator \
  --message "Spawn the content-writer agent and ask it to draft a sample social media post about AI productivity"
```

**Deliverables:**
- [ ] 3 agents configured (orchestrator, content-writer, analyst)
- [ ] Analyst agent sandboxed in browser container
- [ ] Routing bindings set for Slack/Telegram/Discord
- [ ] Slack channel connected and tested
- [ ] MEMORY.md seeded with template
- [ ] Sub-agent delegation verified

---

## Phase 2: Skill Ecosystem Integration (Week 2-3)

### 2.1 Install Meta-Skills (skill-from-masters)

```bash
# Clone and copy meta-skills
git clone https://github.com/SiriusYou/skill-from-masters /tmp/sfm

cp -r /tmp/sfm/skill-from-masters/ workspaces/marketing/skills/meta/skill-from-masters/
cp -r /tmp/sfm/skills/search-skill/ workspaces/marketing/skills/meta/search-skill/
cp -r /tmp/sfm/skills/skill-from-github/ workspaces/marketing/skills/meta/skill-from-github/
cp -r /tmp/sfm/skills/skill-from-notebook/ workspaces/marketing/skills/meta/skill-from-notebook/

# Also copy the methodology database (60+ expert frameworks)
cp /tmp/sfm/methodology-database.md workspaces/marketing/memory/

# Verify
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli skills list
```

### 2.2 Curate Marketing Skills from ClawHub

Reference: awesome-openclaw-skills (145 Marketing & Sales skills)

```bash
# Install ClawHub CLI
npm install -g clawhub

# Search and install top marketing skills
clawhub search "email marketing" --workdir workspaces/marketing/skills/core-marketing/
clawhub search "social media scheduling" --workdir workspaces/marketing/skills/core-marketing/
clawhub search "seo optimization" --workdir workspaces/marketing/skills/core-marketing/
clawhub search "content calendar" --workdir workspaces/marketing/skills/core-marketing/
clawhub search "ab testing" --workdir workspaces/marketing/skills/core-marketing/

# Install top picks (replace with actual slugs from awesome list)
clawhub install <email-campaign-slug> --workdir workspaces/marketing/skills/core-marketing/
clawhub install <social-scheduler-slug> --workdir workspaces/marketing/skills/core-marketing/
clawhub install <seo-analyzer-slug> --workdir workspaces/marketing/skills/core-marketing/
clawhub install <ab-testing-slug> --workdir workspaces/marketing/skills/core-marketing/
clawhub install <content-calendar-slug> --workdir workspaces/marketing/skills/core-marketing/
```

### 2.3 Install Cross-Platform Skills from skills.sh

```bash
# Install Vercel's web performance skills (useful for landing page optimization)
npx skills add vercel-labs/skills

# Search for marketing-relevant community skills
npx skills find "marketing"
npx skills find "analytics"
npx skills find "copywriting"
```

### 2.4 Create Custom Marketing Skills

#### Skill: Campaign Brief Generator

Create `workspaces/marketing/skills/core-marketing/campaign-brief/SKILL.md`:

```markdown
---
name: campaign-brief
description: Generate structured campaign briefs from high-level objectives. Use when planning a new marketing campaign or initiative.
metadata:
  openclaw:
    emoji: "\U0001F4CB"
---

# Campaign Brief Generator

When asked to create a campaign brief, follow this structure:

## Brief Template

1. **Campaign Name**: Descriptive, memorable
2. **Objective**: SMART goal (Specific, Measurable, Achievable, Relevant, Time-bound)
3. **Target Audience**: Primary and secondary personas
4. **Key Message**: Core value proposition (max 1 sentence)
5. **Channels**: Distribution channels with rationale
6. **Timeline**: Start/end dates, milestones
7. **Budget Allocation**: By channel (percentage)
8. **KPIs**: 3-5 measurable metrics
9. **Creative Direction**: Tone, visual style, references
10. **Risks & Mitigations**: Top 3 risks

## Process

1. Search memory for past campaign performance: `memory_search("campaign performance")`
2. Review lessons learned: `memory_get("MEMORY.md")`
3. Generate brief using template above
4. Compare with successful past campaigns
5. Flag any conflicts with brand guidelines
```

#### Skill: Content A/B Tester

Create `workspaces/marketing/skills/core-marketing/content-ab-test/SKILL.md`:

```markdown
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
```

### 2.5 Update Agent Skill Allowlists

```json5
// Update agents.list in config.json5
{
  id: "marketing-orchestrator",
  skills: [
    // Meta
    "clawhub", "skill-from-masters", "search-skill", "skill-from-notebook",
    // Core
    "campaign-brief", "content-ab-test", "email-campaign",
    "social-scheduler", "seo-analyzer", "content-calendar",
  ],
}
```

### 2.6 Validation

```bash
# Full skill status report
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli skills check

# Test meta-skill
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli agent \
  --id marketing-orchestrator \
  --message "Use skill-from-masters to create a new skill for Instagram Reels content optimization based on the methodology database"

# Test custom skill
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli agent \
  --id marketing-orchestrator \
  --message "Use the campaign-brief skill to create a brief for a Q2 product launch"
```

**Deliverables:**
- [ ] 4 meta-skills installed (skill-from-masters suite)
- [ ] 5+ marketing skills from ClawHub installed
- [ ] skills.sh skills installed
- [ ] 2 custom skills created (campaign-brief, content-ab-test)
- [ ] All agents' skill allowlists updated
- [ ] Meta-skill tested: can create new skills

---

## Phase 3: Knowledge Ingestion Pipeline (Week 3-4)

### 3.1 Deploy skill_seekers MCP Server

```bash
# Via Docker (already in compose)
docker compose -f docker-compose.marketing.yml --profile ingest up -d skill-seekers

# Or install locally
pip install skill-seekers
```

#### Option A: MCP Integration (Recommended)

```json5
// Add to config.json5
{
  tools: {
    mcp: [
      {
        name: "skill-seekers",
        command: "python",
        args: ["-m", "skill_seekers.mcp.server_fastmcp"],
        transport: "stdio",
      },
    ],
  },
}
```

#### Option B: CLI Wrapper Skill

Create `workspaces/marketing/skills/platform/skill-seekers-cli/SKILL.md`:

```markdown
---
name: skill-seekers-cli
description: Ingest documentation from websites, GitHub repos, and PDFs using skill_seekers CLI. Use when you need to acquire new marketing knowledge from external sources.
metadata:
  openclaw:
    emoji: "\U0001F4DA"
    requires:
      bins: [skill-seekers]
    install:
      - id: pip
        kind: node
        package: skill-seekers
        bins: [skill-seekers]
        label: Install skill_seekers (pip)
---

# Skill Seekers Knowledge Ingestion

## Scrape Documentation Website
skill-seekers scrape --url <URL> --output ./memory/ --format markdown

## Analyze GitHub Repository
skill-seekers github --repo <owner/repo> --output ./memory/ --format markdown

## Process PDF
skill-seekers pdf --input <file.pdf> --output ./memory/ --format markdown

## Notes
- Output to agent's memory/ directory for automatic indexing
- Use --format markdown for OpenClaw memory compatibility
- Large sources: use --chunk-size 1000 for optimal RAG chunking
```

### 3.2 Initial Knowledge Ingestion

```bash
# Ingest marketing knowledge sources
skill-seekers scrape --url https://blog.hubspot.com/marketing \
  --output workspaces/marketing/memory/hubspot/ \
  --format markdown --max-pages 50

skill-seekers scrape --url https://neilpatel.com/blog/ \
  --output workspaces/marketing/memory/neilpatel/ \
  --format markdown --max-pages 30

# Ingest competitor documentation
skill-seekers scrape --url https://competitor.com/docs \
  --output workspaces/analytics/memory/competitors/ \
  --format markdown
```

### 3.3 Memory Indexing Configuration

```json5
{
  memory: {
    backend: "builtin",
    citations: "auto",
    qmd: {
      paths: [
        { path: "workspaces/marketing/memory/", name: "Marketing Knowledge" },
        { path: "workspaces/marketing/strategies/", name: "Campaign Strategies" },
        { path: "workspaces/marketing/performance/", name: "Performance Data" },
        { path: "workspaces/analytics/memory/", name: "Market Research" },
      ],
      sessions: {
        enabled: true,
        retentionDays: 180,
      },
      update: {
        interval: "5m",
        embedInterval: "30m",
      },
      limits: {
        maxResults: 10,
        maxSnippetChars: 500,
      },
    },
  },
}
```

### 3.4 Automated Ingestion Cron

```json5
{
  cron: {
    jobs: [
      {
        id: "weekly-knowledge-ingest",
        agentId: "marketing-orchestrator",
        enabled: true,
        schedule: { kind: "cron", expr: "0 3 * * 0", tz: "Asia/Shanghai" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Use skill-seekers to refresh knowledge from our tracked marketing blogs and competitor sites. Summarize any new insights and update MEMORY.md.",
        },
      },
    ],
  },
}
```

**Deliverables:**
- [ ] skill_seekers running in Docker container (MCP or CLI)
- [ ] Initial knowledge ingested (3+ sources)
- [ ] Memory indexing configured
- [ ] Weekly auto-ingestion Cron job set

---

## Phase 4: Self-Evolution Loop (Week 4-5)

### 4.1 Feedback Collection Hook

Create `extensions/marketing-feedback/index.ts`:

```typescript
import type { OpenClawPluginApi } from "../src/plugin-sdk/index.js";

export default {
  id: "marketing-feedback",
  name: "Marketing Feedback Loop",
  configSchema: { type: "object", properties: {} },

  register(api: OpenClawPluginApi) {
    // --- Record skill effectiveness after each agent run ---
    api.on("agent_end", async (event, ctx) => {
      if (!ctx.agentId?.startsWith("marketing") && ctx.agentId !== "content-writer") return;

      const logEntry = [
        `| ${new Date().toISOString().split("T")[0]}`,
        `| ${ctx.agentId}`,
        `| ${event.toolsUsed?.join(", ") ?? "none"}`,
        `| ${event.stopReason}`,
        `| ${event.usage?.totalTokens ?? 0}`,
        `| ${event.durationMs ?? 0}ms |`,
      ].join(" ");

      api.logger.info("feedback", logEntry);
    });

    // --- Detect feedback messages and tag campaigns ---
    api.on("message_received", async (event, ctx) => {
      const text = event.text?.toLowerCase() ?? "";
      const feedbackKeywords = ["worked well", "didn't work", "great results",
        "poor performance", "feedback:", "learnings:"];

      if (feedbackKeywords.some((kw) => text.includes(kw))) {
        api.logger.info("feedback", `Campaign feedback detected: ${text.slice(0, 200)}`);
      }
    });

    // --- Inject recent lessons before each agent start ---
    api.on("before_agent_start", async (event, ctx) => {
      if (ctx.agentId !== "marketing-orchestrator") return;

      if (event.systemPromptSections) {
        event.systemPromptSections.push({
          title: "Reminder",
          content:
            "Before making campaign decisions, always search memory for recent lessons: memory_search('campaign lessons learned')",
        });
      }
    });
  },
};
```

### 4.2 Skill Audit Hook (Security Gate)

Create `extensions/skill-audit/index.ts`:

```typescript
import type { OpenClawPluginApi } from "../src/plugin-sdk/index.js";

const DANGEROUS_PATTERNS = [
  /exec\s*\(/,
  /child_process/,
  /curl.*\|\s*(?:ba)?sh/,
  /eval\s*\(/,
  /rm\s+-rf/,
  /\.env\b/,
  /credentials/,
  /process\.env/,
  /require\s*\(\s*['"](?:fs|net|http|child_process)['"]\s*\)/,
];

export default {
  id: "skill-audit",
  name: "Skill Audit Gate",
  configSchema: { type: "object", properties: {} },

  register(api: OpenClawPluginApi) {
    api.on("after_tool_call", async (event, ctx) => {
      const path = event.input?.path ?? event.input?.file_path ?? "";
      if (!path.includes("skills/evolved/")) return;

      const content = typeof event.result === "string" ? event.result : "";

      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(content)) {
          api.logger.warn(
            "skill-audit",
            `BLOCKED: Evolved skill at ${path} contains dangerous pattern: ${pattern.source}`,
          );
          return;
        }
      }

      api.logger.info("skill-audit", `Approved evolved skill: ${path}`);
    });
  },
};
```

### 4.3 Self-Reflection Cron Jobs

```json5
{
  cron: {
    jobs: [
      // Daily morning brief
      {
        id: "daily-morning-brief",
        agentId: "marketing-orchestrator",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "Morning brief: 1) Search memory for yesterday's campaign results. 2) Review any feedback received. 3) Suggest today's top 3 priorities. 4) Post summary to Slack.",
        },
        delivery: { mode: "announce", channel: "slack" },
      },

      // Weekly strategy reflection
      {
        id: "weekly-strategy-reflection",
        agentId: "analyst",
        enabled: true,
        schedule: { kind: "cron", expr: "0 10 * * 1", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "Weekly reflection: 1) Analyze this week's session transcripts. 2) Identify top 3 wins and 3 failures. 3) Calculate cost per successful campaign action. 4) Update MEMORY.md lessons learned section. 5) Recommend skill improvements or new skills to create.",
        },
        delivery: { mode: "announce", channel: "slack" },
      },

      // Bi-weekly skill evolution
      {
        id: "biweekly-skill-evolution",
        agentId: "marketing-orchestrator",
        enabled: true,
        schedule: { kind: "cron", expr: "0 14 1,15 * *", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "Skill evolution cycle: 1) Review skill effectiveness data in MEMORY.md. 2) Identify gaps - tasks where no skill was available. 3) Use skill-from-masters to create 1-2 new skills for top gaps. 4) Use clawhub search to find existing skills for other gaps. 5) Save new skills to skills/evolved/ directory. 6) Update MEMORY.md skill inventory.",
        },
      },
    ],
  },
}
```

### 4.4 Evolution Data Flow

```
Daily:
  Agent runs -> Hook records tool/skill usage -> Performance log

Weekly:
  Analyst reads transcripts -> Identifies patterns -> Updates MEMORY.md

Bi-weekly:
  Orchestrator reads MEMORY.md -> Identifies skill gaps ->
    -> clawhub search (existing skills) OR
    -> skill-from-masters (create new) ->
  New SKILL.md in evolved/ -> Audit hook validates -> Available next run
```

**Deliverables:**
- [ ] marketing-feedback plugin created and registered
- [ ] skill-audit plugin created and registered
- [ ] 3 Cron jobs configured (daily/weekly/bi-weekly)
- [ ] First self-evolution cycle completed manually
- [ ] Evolved skill directory has first agent-created skill

---

## Phase 5: Observability & Cost Control (Week 5-6)

### 5.1 Enable Full Diagnostics

```json5
{
  diagnostics: {
    enabled: true,
    flags: [
      "gateway.*",
      "session.*",
      "webhook.*",
      "agent.*",
    ],
  },
  logging: {
    level: "info",
    redactSensitive: true,
    consoleLevel: "info",
  },
}
```

### 5.2 Cost Monitoring Cron

```json5
{
  cron: {
    jobs: [
      {
        id: "daily-cost-report",
        agentId: "analyst",
        enabled: true,
        schedule: { kind: "cron", expr: "0 18 * * *", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "Daily cost report: 1) Load today's session usage data. 2) Break down cost by agent (orchestrator vs content-writer vs analyst). 3) Calculate cost per marketing action. 4) Flag if daily spend exceeds $20. 5) Post summary to Slack with trend vs last 7 days.",
        },
        delivery: { mode: "announce", channel: "slack" },
      },
    ],
  },
}
```

### 5.3 Model Cost Optimization

```json5
{
  agents: {
    list: [
      {
        id: "marketing-orchestrator",
        model: {
          primary: "claude-sonnet-4-5-20250929",  // ~$3/1M input, $15/1M output
          fallbacks: ["claude-opus-4-6"],           // ~$15/1M input, $75/1M output
        },
      },
      {
        id: "content-writer",
        model: "claude-sonnet-4-5-20250929",       // Content gen = Sonnet sufficient
      },
      {
        id: "analyst",
        model: {
          primary: "claude-opus-4-6",              // Deep analysis = Opus
          fallbacks: ["claude-sonnet-4-5-20250929"],
        },
      },
    ],
  },

  // Auth profile rotation for rate limit resilience
  models: {
    authProfiles: [
      { id: "anthropic-1", provider: "anthropic", apiKey: "${ANTHROPIC_API_KEY_1}" },
      { id: "anthropic-2", provider: "anthropic", apiKey: "${ANTHROPIC_API_KEY_2}" },
    ],
  },
}
```

### 5.4 Key Metrics to Track

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Daily token spend | session-cost-usage | > $20/day |
| Agent latency p95 | diagnostic-events | > 30s |
| Stuck sessions | diagnostic heartbeat | > 120s |
| Failed tool calls | after_tool_call hook | > 5/hour |
| Skill usage count | marketing-feedback | skill unused > 2 weeks |
| Model fallback rate | model-fallback logs | > 10% fallbacks |

**Deliverables:**
- [ ] Diagnostics enabled with all relevant flags
- [ ] Daily cost report Cron running
- [ ] Model assignments optimized per agent role
- [ ] Auth profile rotation configured (2+ keys)
- [ ] Alert thresholds documented

---

## Phase 6: Browser Automation & Competitive Intelligence (Week 6-7)

### 6.1 Enable Browser Tools for Analyst

Already configured in Phase 1 agent definition (sandbox + browser tools). Verify:

```bash
docker compose -f docker-compose.marketing.yml run --rm openclaw-cli agent \
  --id analyst \
  --message "Navigate to https://example.com and take a screenshot"
```

### 6.2 Competitive Intelligence Cron

```json5
{
  cron: {
    jobs: [
      {
        id: "daily-competitor-watch",
        agentId: "analyst",
        enabled: true,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "Competitor monitoring: 1) Navigate to each competitor URL listed in MEMORY.md. 2) Take screenshot and accessibility snapshot. 3) Compare with previous observations in memory. 4) Record any pricing changes, new features, or messaging shifts. 5) Update MEMORY.md competitor intelligence section. 6) If significant change detected, post alert to Slack.",
        },
      },
      {
        id: "weekly-seo-audit",
        agentId: "analyst",
        enabled: true,
        schedule: { kind: "cron", expr: "0 11 * * 3", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "SEO audit: 1) Navigate to our key landing pages. 2) Snapshot accessibility tree and check meta tags, H1 structure, image alts. 3) Compare with competitor pages. 4) Generate recommendations. 5) Post report to Slack.",
        },
      },
    ],
  },
}
```

### 6.3 Tailscale Integration (Team Access)

When the team needs remote access to the running system:

```bash
# Install Tailscale on the Docker host
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update compose to bind to Tailscale
# In .env:
OPENCLAW_GATEWAY_BIND=tailnet

# Restart gateway
docker compose -f docker-compose.marketing.yml up -d openclaw-gateway

# Team members access via Tailscale IP
# e.g., http://100.x.y.z:18789
```

**Deliverables:**
- [ ] Browser tools verified in sandbox container
- [ ] Daily competitor watch running
- [ ] Weekly SEO audit running
- [ ] noVNC accessible for human observation of browser sessions
- [ ] (Optional) Tailscale configured for team access

---

## Phase 7: Production Hardening (Week 7-8)

### 7.1 Progressive Channel Unlock

```json5
{
  session: {
    sendPolicy: {
      default: "deny",
      rules: [
        // Phase 1: Internal (already active)
        { action: "allow", match: { channel: "slack", chatType: "group" } },
        // Phase 7: External channels (now unlocked)
        { action: "allow", match: { channel: "telegram", chatType: "group" } },
        { action: "allow", match: { channel: "discord", chatType: "group" } },
        // DMs still require explicit pairing
      ],
    },
  },
}
```

### 7.2 Heartbeat Configuration

```json5
{
  agents: {
    list: [
      {
        id: "marketing-orchestrator",
        heartbeat: {
          enabled: true,
          intervalMs: 300000,  // 5 minutes
        },
      },
    ],
  },
}
```

### 7.3 Content Pipeline Cron

```json5
{
  cron: {
    jobs: [
      {
        id: "daily-content-pipeline",
        agentId: "content-writer",
        enabled: true,
        schedule: { kind: "cron", expr: "0 14 * * 1-5", tz: "Asia/Shanghai" },
        payload: {
          kind: "agentTurn",
          message: "Daily content pipeline: 1) Check content calendar in memory. 2) Review today's scheduled topics. 3) Search memory for relevant past content and lessons. 4) Generate draft posts for each scheduled channel. 5) Apply A/B test variants where applicable. 6) Post drafts to Slack #content-review for human approval.",
        },
        delivery: { mode: "announce", channel: "slack" },
      },
    ],
  },
}
```

### 7.4 Disaster Recovery

```bash
#!/bin/bash
# backup-openclaw.sh — Run via system cron, not OpenClaw cron
BACKUP_DIR="$HOME/openclaw-backups/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# Config
cp -r ~/.openclaw/config.json5 "$BACKUP_DIR/"
cp -r ~/.openclaw/credentials/ "$BACKUP_DIR/credentials/"

# Workspaces (skills, memory, strategies)
tar czf "$BACKUP_DIR/workspaces.tar.gz" workspaces/

# Evolved skills git repo
cd workspaces/marketing/skills/evolved && git bundle create "$BACKUP_DIR/evolved-skills.bundle" --all

# Session transcripts (last 30 days)
find ~/.openclaw/sessions/ -name "transcript.jsonl" -mtime -30 \
  -exec tar czf "$BACKUP_DIR/recent-transcripts.tar.gz" {} +

# Docker volumes
docker run --rm -v openclaw-config:/data -v "$BACKUP_DIR":/backup \
  alpine tar czf /backup/docker-config-volume.tar.gz -C /data .

echo "Backup completed: $BACKUP_DIR"
```

### 7.5 Final Validation Checklist

```bash
COMPOSE="docker compose -f docker-compose.marketing.yml run --rm openclaw-cli"

# Security
$COMPOSE doctor
$COMPOSE skills check

# Agent functionality
$COMPOSE agent --id marketing-orchestrator \
  --message "Run a full system check: list skills, verify memory access, confirm sub-agent connectivity"

# Cron jobs
$COMPOSE cron list
$COMPOSE cron run daily-morning-brief --dry-run

# Channels
$COMPOSE channels status

# Container health
docker compose -f docker-compose.marketing.yml ps
```

**Deliverables:**
- [ ] External channels unlocked with send policy
- [ ] Heartbeat monitoring active
- [ ] Content pipeline Cron running daily
- [ ] Backup script tested (including Docker volumes)
- [ ] Full system validation passed

---

## Phase 8: Production Deployment & Scaling (Week 8-9)

### 8.1 Production Docker Compose

Create `docker-compose.production.yml`:

```yaml
services:
  # --- Core Gateway (hardened) ---
  openclaw-gateway:
    image: openclaw:local
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop:
      - ALL
    environment:
      HOME: /home/node
      NODE_ENV: production
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    volumes:
      - openclaw-config:/home/node/.openclaw
      - openclaw-workspaces:/app/workspaces
      - openclaw-data:/app/data
    ports:
      - "127.0.0.1:18789:18789"
    tmpfs:
      - /tmp:noexec,nosuid,size=256m
    command:
      - node
      - openclaw.mjs
      - gateway
      - --bind
      - ${OPENCLAW_GATEWAY_BIND:-loopback}
      - --port
      - "18789"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:18789/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: "2.0"

  # --- Browser Sandbox (hardened) ---
  sandbox-browser:
    image: openclaw-sandbox-browser:bookworm-slim
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    environment:
      OPENCLAW_BROWSER_CDP_PORT: 9222
      OPENCLAW_BROWSER_HEADLESS: 0
      OPENCLAW_BROWSER_ENABLE_NOVNC: 1
    ports:
      - "127.0.0.1:9222:9222"
      - "127.0.0.1:6080:6080"
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: "1.0"

  # --- Tool Sandbox (hardened) ---
  sandbox:
    image: openclaw-sandbox:bookworm-slim
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:noexec,nosuid,size=128m
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"

volumes:
  openclaw-config:
    driver: local
  openclaw-workspaces:
    driver: local
  openclaw-data:
    driver: local
```

### 8.2 Fly.io Private Deployment (Alternative)

For 7x24 cloud hosting without public exposure:

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Create app
fly apps create my-marketing-agent

# Set secrets
fly secrets set \
  OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32) \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-...

# Deploy using private config (no public IP)
cp fly.private.toml fly.toml
fly deploy

# Access via proxy (local port forwarding)
fly proxy 18789:3000 -a my-marketing-agent

# Or via WireGuard (persistent tunnel)
fly wireguard create
```

Fly.io specs:
- VM: `shared-cpu-2x`, 2048MB RAM
- Storage: Persistent volume at `/data`
- Auto-restart on crash
- No public IP (access via `fly proxy` or WireGuard only)
- Cost: ~$10-30/month

### 8.3 Render.com Deployment (Quick Alternative)

For teams wanting the simplest deployment:

```bash
# Push to GitHub, then connect via Render dashboard
# Or use render.yaml (already in repo)
```

Render specs:
- Starter plan (free tier available)
- Health check at `/health`
- 1GB persistent disk
- Auto-deploy from Git
- Auto-generated gateway token

### 8.4 Deployment Comparison

| Criteria | Docker Compose | Fly.io Private | Render.com |
|----------|---------------|----------------|------------|
| Setup time | 30 min | 15 min | 10 min |
| Monthly cost | $0 (own hardware) | ~$10-30 | $0-25 |
| Uptime | Depends on host | 99.9%+ | 99.5%+ |
| Auto-restart | `unless-stopped` | Built-in | Built-in |
| Auto-TLS | No (manual) | Yes (Let's Encrypt) | Yes |
| Public exposure | Loopback only | Optional (private default) | Yes |
| Persistent storage | Docker volumes | Fly volumes | 1GB disk |
| Browser sandbox | Yes (separate container) | No (single container) | No |
| Resource limits | Configurable | shared-cpu-2x / 2GB | Plan-dependent |
| Team access | Tailscale | fly proxy / WireGuard | Public URL |

### 8.5 Production Monitoring

```bash
# Docker Compose
docker compose -f docker-compose.production.yml logs -f openclaw-gateway
docker compose -f docker-compose.production.yml ps

# Fly.io
fly logs -a my-marketing-agent
fly status -a my-marketing-agent
fly ssh console -a my-marketing-agent

# System cron for backup (add to host crontab)
# 0 2 * * * /path/to/backup-openclaw.sh
```

**Deliverables:**
- [ ] Production Docker Compose validated with resource limits
- [ ] OR Fly.io private deployment running
- [ ] OR Render.com deployment running
- [ ] Backup cron job in host system crontab
- [ ] Monitoring commands documented
- [ ] Team access method configured (Tailscale / fly proxy / public URL)

---

## Appendix A: Security Checklist

### Pre-Deployment

- [ ] Gateway bound to `loopback` (not `0.0.0.0`)
- [ ] Gateway token set (min 32 bytes random)
- [ ] `logging.redactSensitive: true`
- [ ] Agent tools use `allowlist` policy (not `all`)
- [ ] skill-audit hook active
- [ ] evolved/ directory under git version control
- [ ] Only awesome-openclaw-skills whitelist skills installed
- [ ] Node.js >= 22.12.0
- [ ] Docker containers: `read_only`, `cap_drop: ALL`, non-root USER
- [ ] All ports bound to `127.0.0.1` (not `0.0.0.0`)
- [ ] `.env` file excluded from git (`.gitignore`)

### Ongoing

- [ ] Weekly: review evolved skills git diff
- [ ] Weekly: check `openclaw skills check` for anomalies
- [ ] Monthly: rotate API keys
- [ ] Monthly: `clawhub update --all` for skill patches
- [ ] Monthly: `npm audit` on OpenClaw dependencies
- [ ] Monthly: `docker scan` on container images

---

## Appendix B: Configuration Reference

### Complete config.json5 Template

See individual phases above. The full config combines:

| Section | Phase | Purpose |
|---------|-------|---------|
| `gateway.*` | 0 | Network security |
| `logging.*`, `diagnostics.*` | 0, 5 | Observability |
| `agents.list[]` | 1 | Agent definitions |
| `bindings[]` | 1 | Channel routing |
| `channels.*` | 1 | Channel connections |
| `memory.*` | 3 | Knowledge indexing |
| `cron.jobs[]` | 3, 4, 5, 6, 7 | Automation schedule |
| `tools.mcp[]` | 3 | skill_seekers MCP |
| `browser.*` | 6 | Browser automation |
| `session.sendPolicy` | 0, 7 | Permission gates |
| `models.authProfiles[]` | 5 | Key rotation |

### Cron Job Summary

| ID | Agent | Schedule | Purpose |
|----|-------|----------|---------|
| weekly-knowledge-ingest | orchestrator | Sun 03:00 | Refresh knowledge sources |
| daily-morning-brief | orchestrator | Daily 09:00 | Strategy + priorities |
| weekly-strategy-reflection | analyst | Mon 10:00 | Performance review |
| biweekly-skill-evolution | orchestrator | 1st, 15th 14:00 | Create/improve skills |
| daily-cost-report | analyst | Daily 18:00 | Budget monitoring |
| daily-competitor-watch | analyst | Daily 08:00 | Competitive intel |
| weekly-seo-audit | analyst | Wed 11:00 | SEO analysis |
| daily-content-pipeline | content-writer | Mon-Fri 14:00 | Content generation |
| skill-discovery | orchestrator | Mon 10:00 | Find new skills |

### Container Image Summary

| Image | Base | Size | User | Ports | Purpose |
|-------|------|------|------|-------|---------|
| `openclaw:local` | node:22-bookworm | ~1.5GB | node (1000) | 18789 | Gateway + agents |
| `openclaw-sandbox:bookworm-slim` | debian:bookworm-slim | ~200MB | sandbox | none | Tool execution |
| `openclaw-sandbox-browser:bookworm-slim` | debian:bookworm-slim | ~800MB | sandbox | 9222, 5900, 6080 | Browser automation |
| `python:3.12-slim` | python:3.12-slim | ~150MB | root | none | skill_seekers MCP |

---

## Appendix C: Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Phase |
|---|------|-----------|--------|------------|-------|
| 1 | Malicious skill installation | Medium | High | awesome whitelist + skill-audit hook | 2, 4 |
| 2 | API cost overrun | Medium | Medium | Daily cost report + budget alerts | 5 |
| 3 | Agent sends inappropriate content | Low | High | send policy + human review Slack channel | 0, 7 |
| 4 | Prompt injection via channel messages | Medium | Medium | tool allowlists + mention-gating | 1 |
| 5 | Gateway exposed to internet | Low | Critical | loopback binding + TLS + Tailscale | 0 |
| 6 | API key leak in logs | Low | High | redactSensitive: true | 0 |
| 7 | Evolved skill quality degradation | Medium | Medium | git tracking + periodic human review | 4 |
| 8 | Single point of failure (one API key) | Medium | Medium | auth profile rotation (2+ keys) | 5 |
| 9 | Memory bloat (too much indexed data) | Low | Low | retention policy + periodic cleanup | 3 |
| 10 | Channel rate limiting (Telegram/Slack) | Medium | Low | Outbound throttling + fallback channels | 7 |
| 11 | Container escape via sandbox | Low | Critical | read_only + cap_drop ALL + non-root | 0 |
| 12 | Docker volume data loss | Low | High | Daily backup script + volume snapshots | 7 |
| 13 | Browser sandbox resource exhaustion | Medium | Low | Resource limits (1GB/1CPU) + restart policy | 8 |

---

## Appendix D: Container Decision Matrix

### When to Use Each Container

| Scenario | Container(s) | Why |
|----------|-------------|-----|
| Development & testing | gateway + cli | Minimal setup, fast iteration |
| Adding browser automation | + sandbox-browser | Isolated Chromium, noVNC for debugging |
| Running agent tools safely | + sandbox | Non-root, read-only, capabilities dropped |
| Knowledge ingestion | + skill-seekers | Python runtime for MCP server |
| Team collaboration | + Tailscale sidecar | Encrypted remote access, no public exposure |
| Production 7x24 | Fly.io private | Auto-restart, persistent volumes, no public IP |

### Container Lifecycle

```
Development (Week 1-6):
  docker compose -f docker-compose.marketing.yml up -d
  ├── openclaw-gateway (always running)
  ├── sandbox (always running)
  ├── sandbox-browser (always running)
  ├── openclaw-cli (on demand: --profile cli)
  └── skill-seekers (on demand: --profile ingest)

Production (Week 8+):
  docker compose -f docker-compose.production.yml up -d
  ├── openclaw-gateway (hardened, resource-limited)
  ├── sandbox (hardened, resource-limited)
  └── sandbox-browser (hardened, resource-limited)

  OR

  fly deploy (using fly.private.toml)
  └── single VM with persistent volume
```

### Scaling Path

```
Stage 1: Single Docker host
  All containers on one machine
  Cost: $0 (own hardware)

Stage 2: Docker + Tailscale
  Same setup, team access via encrypted tunnel
  Cost: $0 (Tailscale free tier)

Stage 3: Fly.io Private
  Gateway in cloud, 7x24 uptime
  Browser sandbox remains local (or separate Fly machine)
  Cost: ~$10-30/month

Stage 4: Multi-machine (if needed)
  Gateway on Fly.io
  Browser sandbox on dedicated VM (CPU-intensive)
  skill_seekers on scheduled cloud function
  Cost: ~$50-100/month
```
