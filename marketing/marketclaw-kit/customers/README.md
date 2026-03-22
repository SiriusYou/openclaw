# Customer Manifests

Each file `{customerId}.json` defines a customer instance for the multi-client platform.

## Identity Constraint

**`customerId = profile`** — these two MUST be identical.
This unified ID determines the state dir (`~/.openclaw-{id}/`), config path, and service name.

**Agent ID**: Within each profile, the agent ID is always `main` due to an OpenClaw
session path validation constraint. This is safe because each profile has its own
isolated state directory — profile A's `agents/main/` is completely separate from
profile B's `agents/main/`.

## Fields

| Field                        | Type     | Description                                                                   |
| ---------------------------- | -------- | ----------------------------------------------------------------------------- |
| `customerId`                 | string   | Unique identifier (alphanumeric + hyphen)                                     |
| `status`                     | enum     | `template`, `active`, `provisioned`, `paused`, `disabled`                     |
| `port`                       | number   | Gateway port (unique per customer, start at 18790)                            |
| `channels`                   | string[] | Enabled channel plugins                                                       |
| `telegramBotToken`           | object   | Token reference (never plaintext in this file)                                |
| `brandName`                  | string   | Customer's brand name                                                         |
| `audience`                   | string   | Target audience description                                                   |
| `modelProfile`               | object   | LLM model configuration (primary + fallbacks)                                 |
| `skills`                     | string[] | Enabled skills for this customer                                              |
| `sandbox`                    | object   | Sandbox configuration (default: off)                                          |
| `tools`                      | object   | Tool access control                                                           |
| `hostBoundSkillsDenylist`    | string[] | Skills to disable (shared host state)                                         |
| `costAlert`                  | object   | Cost alert thresholds (optional, defaults: dailyWarning=15, dailyCritical=20) |
| `costAlert.dailyWarning`     | number   | Daily cost ($) that triggers WARNING status                                   |
| `costAlert.dailyCritical`    | number   | Daily cost ($) that triggers CRITICAL status                                  |
| `reporting`                  | object   | Reporting configuration (optional)                                            |
| `reporting.timezone`         | string   | IANA timezone for cron scheduling (default: Asia/Shanghai)                    |
| `reporting.delivery`         | object   | Delivery config                                                               |
| `reporting.delivery.channel` | string   | Delivery channel (default: telegram)                                          |
| `reporting.delivery.target`  | string   | Delivery target (e.g. Telegram chat ID). **Required** — fail-closed if empty  |
| `reporting.weekly`           | object   | Weekly summary cron config                                                    |
| `reporting.weekly.cron`      | string   | Cron expression (default: `0 9 * * 1` — Mon 09:00)                            |
| `reporting.monthly`          | object   | Monthly retrospective cron config                                             |
| `reporting.monthly.cron`     | string   | Cron expression (default: `0 9 1 * *` — 1st of month)                         |

## Derived Fields (NOT stored — computed at runtime)

These are derived from `customerId` + platform rules:

- `profile` = `customerId`
- `agentId` = always `main` (within each profile's isolated state dir)
- `stateDir` = `~/.openclaw-{customerId}/`
- `configPath` = `~/.openclaw-{customerId}/openclaw.json`
- `workspace` = `~/.openclaw-{customerId}/workspaces/marketing`
- `serviceName` = per-platform (LaunchAgent on macOS)

## Exec Approvals

Exec security is set to `deny` for customers (safest posture). Customer agents
interact via Telegram and curated marketing skills — no arbitrary shell execution needed.

**Important**: `~/.openclaw/exec-approvals.json` is a shared file (not profile-scoped).
All profiles' entries are keyed by agent ID. Since all profiles use `main`, exec
allowlist mode would cause cross-customer collisions. This is why we use `deny` mode.

## Usage

```bash
# Create a new customer
cp example.json acme-corp.json
# Edit acme-corp.json with customer details
../scripts/provision-customer.sh create acme-corp
```

---

## Onboarding Checklist

Step-by-step procedure for onboarding a new customer (operator-executed).

### Prerequisites

- [ ] Customer has provided: brand name, target audience, brand voice/tone (optional)
- [ ] Telegram bot created via @BotFather (record bot username and token)
- [ ] API keys ready (at least one chain-compatible provider: Google or OpenRouter)
- [ ] Unique port allocated (check existing manifests to avoid conflicts)

### Steps

1. **Create manifest**:

   ```bash
   cp customers/example.json customers/acme-corp.json
   ```

   Edit `acme-corp.json`: set `customerId`, `brandName`, `audience`, `port`, `reporting.delivery.target`.

2. **Provision**:

   ```bash
   bash scripts/provision-customer.sh create acme-corp
   ```

   This creates the state dir, config, workspace, seeds templates, copies skills, and starts the gateway.

3. **Add Telegram bot token**:

   ```bash
   openclaw --profile acme-corp channels add --channel telegram --token '<BOT_TOKEN>'
   ```

4. **Add API keys** (edit auth profiles directly):

   ```bash
   # Edit ~/.openclaw-acme-corp/agents/main/agent/auth-profiles.json
   # Add provider entries with type: "api_key" and key: "<KEY>"
   ```

5. **Restart gateway** to apply token and auth changes:

   ```bash
   openclaw --profile acme-corp daemon restart
   ```

6. **Verify Telegram pairing**:
   - Send a message to the bot from Telegram
   - Bot returns a pairing code (message is NOT processed yet)
   - Approve: `openclaw --profile acme-corp pairing approve telegram <CODE>`
   - Send another test message — bot should respond normally

7. **Configure automated reports** (if `reporting` section is in manifest):

   ```bash
   bash scripts/configure-customer-crons.sh acme-corp
   ```

8. **Customize workspace** (optional):
   - Edit `~/.openclaw-acme-corp/workspaces/marketing/memory/brand-and-audience.md`
   - Edit `~/.openclaw-acme-corp/workspaces/marketing/SOUL.md`

9. **Run first campaign** (process validation):
   - Send via Telegram: "Create a campaign brief for [topic]. Use the campaign-lifecycle skill."
   - Walk through all 7 phases (IDEATE through LEARN)
   - Verify weekly summary cron fires on next Monday

10. **Delivery confirmation**:
    - [ ] Bot responds to Telegram messages
    - [ ] Gateway health: `openclaw --profile acme-corp gateway status --require-rpc`
    - [ ] Cron jobs listed: `openclaw --profile acme-corp cron list`
    - [ ] First campaign completed or in progress
