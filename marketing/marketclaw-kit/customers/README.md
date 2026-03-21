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

| Field                       | Type     | Description                                                                  |
| --------------------------- | -------- | ---------------------------------------------------------------------------- |
| `customerId`                | string   | Unique identifier (alphanumeric + hyphen)                                    |
| `status`                    | enum     | `template`, `active`, `provisioned`, `paused`, `disabled`                    |
| `port`                      | number   | Gateway port (unique per customer, start at 18790)                           |
| `channels`                  | string[] | Enabled channel plugins                                                      |
| `telegramBotToken`          | object   | Token reference (never plaintext in this file)                               |
| `brandName`                 | string   | Customer's brand name                                                        |
| `audience`                  | string   | Target audience description                                                  |
| `modelProfile`              | object   | LLM model configuration (primary + fallbacks)                                |
| `skills`                    | string[] | Enabled skills for this customer                                             |
| `sandbox`                   | object   | Sandbox configuration (default: off)                                         |
| `tools`                     | object   | Tool access control                                                          |
| `hostBoundSkillsDenylist`   | string[] | Skills to disable (shared host state)                                        |
| `reporting`                 | object   | Reporting configuration (optional)                                           |
| `reporting.delivery.target` | string   | Delivery target (e.g. Telegram chat ID). **Required** — fail-closed if empty |

## Derived Fields (NOT stored — computed at runtime)

- `profile` = `customerId`
- `agentId` = always `main`
- `stateDir` = `~/.openclaw-{customerId}/`
- `configPath` = `~/.openclaw-{customerId}/openclaw.json`
- `workspace` = `~/.openclaw-{customerId}/workspaces/marketing`

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
- [ ] API keys ready (at least one chain-compatible: Google or OpenRouter)
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

3. **Add Telegram bot token**:

   ```bash
   openclaw --profile acme-corp channels add --channel telegram --token '<BOT_TOKEN>'
   ```

4. **Add API keys** (Node script writes directly to auth-profiles.json):

   ```bash
   AUTH_DIR=~/.openclaw-acme-corp/agents/main/agent node -e "
   const fs = require('fs');
   const dir = process.env.AUTH_DIR;
   fs.mkdirSync(dir, { recursive: true });
   const path = dir + '/auth-profiles.json';
   const store = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
   store.profiles = store.profiles || {};
   const norm = (s) => s.trim().replace(/[^\x20-\x7E]/g, '');
   store.profiles['google:default'] = { type: 'api_key', provider: 'google', key: norm('YOUR_GOOGLE_KEY') };
   store.profiles['openrouter:default'] = { type: 'api_key', provider: 'openrouter', key: norm('YOUR_OPENROUTER_KEY') };
   fs.writeFileSync(path, JSON.stringify(store, null, 2));
   "
   ```

5. **Restart gateway**:

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

9. **Delivery confirmation**:
   - [ ] Bot responds to Telegram messages
   - [ ] Gateway health: `openclaw --profile acme-corp gateway status --require-rpc`
   - [ ] Cron jobs listed: `openclaw --profile acme-corp cron list`
