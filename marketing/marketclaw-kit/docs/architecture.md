# Architecture Overview

## Gateway-Per-Customer Isolation

Each customer runs as an independent OpenClaw gateway instance:

```
Operator Machine
├── Operator Gateway (port 18789)
│   ├── ~/.openclaw/
│   ├── main agent (internal operations)
│   └── Telegram: @operator_bot
│
├── Customer A Gateway (port 18790)
│   ├── ~/.openclaw-customer-a/
│   ├── main agent (customer A marketing)
│   └── Telegram: @customer_a_bot
│
└── Customer B Gateway (port 18791)
    ├── ~/.openclaw-customer-b/
    ├── main agent (customer B marketing)
    └── Telegram: @customer_b_bot
```

### What's isolated per customer

| Resource     | Isolation Method                                        |
| ------------ | ------------------------------------------------------- |
| Config       | `~/.openclaw-{id}/openclaw.json`                        |
| State        | `~/.openclaw-{id}/` (sessions, logs, caches)            |
| Workspace    | `~/.openclaw-{id}/workspaces/marketing/`                |
| Auth         | `~/.openclaw-{id}/agents/main/agent/auth-profiles.json` |
| Gateway port | Unique port per customer (18790, 18791, ...)            |
| Telegram bot | Independent bot token per customer                      |
| LaunchAgent  | Per-profile macOS service                               |
| Cron jobs    | Per-gateway (customer's own cron scheduler)             |

### Isolation model (macOS Phase 1)

- **Process isolation**: Each gateway is an independent process
- **Path isolation**: `--profile` flag routes all state to `~/.openclaw-{id}/`
- **Network isolation**: Each gateway binds to its own port on loopback
- **NOT OS-user isolated**: All profiles run under the same macOS user (operator compromise)

For stronger isolation (future Linux deployment), use independent OS users per customer.

## Skill Distribution

Skills use OpenClaw's layered override system:

```
Priority (highest to lowest):
1. <workspace>/skills/     — per-customer customizations
2. ~/.openclaw/skills/     — shared operator skills
3. bundled skills          — OpenClaw built-ins
4. skills.load.extraDirs   — additional skill directories
```

The kit provisions each customer with 9 core-marketing skills in their workspace:

| Skill                  | Campaign Phase                  |
| ---------------------- | ------------------------------- |
| structured-brainstorm  | Phase 1: IDEATE                 |
| campaign-brief         | Phase 2: PLAN                   |
| content-ab-test        | Phase 3: CREATE                 |
| content-repurposing    | Phase 3: CREATE (multi-channel) |
| campaign-decision-gate | Phase 4: GATE                   |
| campaign-lifecycle     | All phases (orchestrator)       |
| weekly-summary         | Phase 6: ANALYZE                |
| campaign-retrospective | Phase 7: LEARN                  |
| campaign-diagnosis     | Any (troubleshooting)           |

## Security Model

### Sandbox: Off

Customer agents run with `sandbox.mode: "off"`. This is acceptable because:

- Customers interact only via Telegram (no direct code execution)
- All skills are operator-curated (no user-installed code)
- The agent has no exec tools (`tools.exec.security: "deny"`)

### Tool Restrictions

| Setting                  | Value  | Effect                           |
| ------------------------ | ------ | -------------------------------- |
| `sandbox.mode`           | `off`  | No Docker sandboxing             |
| `tools.exec.security`    | `deny` | No shell command execution       |
| `tools.fs.workspaceOnly` | `true` | File access limited to workspace |
| `tools.profile`          | `full` | Base tool set available          |

### Host-Bound Skill Denylist

Skills that access shared host state are blocked for customer profiles:

- `things-mac` — accesses macOS system APIs
- `tmux` — accesses shared terminal sessions
- `1password` — accesses shared password vault

### API Key Security

- Keys stored in per-profile `auth-profiles.json` (not in config or env)
- Gateway daemon does NOT inherit shell environment variables
- Each customer can use their own API keys
- `pre-package-scan.sh` ensures zero secrets in the repository

## Cron Reporting System

Each customer gateway runs its own cron scheduler:

```
Customer A Gateway
├── acme-weekly-summary       (Mon 09:00)
└── acme-monthly-retrospective (1st of month 09:00)

Customer B Gateway
├── beta-weekly-summary       (Mon 09:00)
└── beta-monthly-retrospective (1st of month 09:00)
```

Cron jobs are per-gateway (isolated). Reports are delivered to the customer's Telegram and written to the customer's workspace `status/` directory.

## Backup Strategy

- `daily-backup.sh` creates date-stamped snapshots of critical files
- `provision-customer.sh export` creates a full customer data archive
- 30-day retention policy on automated backups
- Backup scope: config, auth profiles, workspace, skills, memory

## Model Chain

The kit uses a two-tier provider architecture:

```
Primary:  google/gemini-3-pro-preview  (Google API key)
Fallback: openrouter/auto              (OpenRouter API key)
```

Both providers use simple API key authentication (no OAuth required). At least one chain-compatible key (Google or OpenRouter) is required for the kit to function.
