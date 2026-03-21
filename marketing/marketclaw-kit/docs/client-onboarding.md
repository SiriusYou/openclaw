# Client Onboarding Guide

Step-by-step procedure for onboarding a new customer. All steps are executed by the operator.

## Prerequisites

Before starting:

- [ ] Customer has provided: brand name, target audience, brand voice/tone (optional)
- [ ] Telegram bot created via [@BotFather](https://t.me/BotFather) (record bot username and token)
- [ ] API keys ready (at least one chain-compatible: Google or OpenRouter)
- [ ] Unique port allocated (check existing manifests to avoid conflicts)

## Step 1: Create Customer Manifest

```bash
cp customers/example.json customers/acme-corp.json
```

Edit `acme-corp.json`:

```json
{
  "customerId": "acme-corp",
  "status": "template",
  "port": 18790,
  "channels": ["telegram"],
  "brandName": "Acme Corporation",
  "audience": "Small business owners looking for automation solutions",
  "reporting": {
    "timezone": "America/New_York",
    "delivery": {
      "channel": "telegram",
      "target": "CUSTOMER_CHAT_ID"
    },
    "weekly": { "cron": "0 9 * * 1" },
    "monthly": { "cron": "0 9 1 * *" }
  }
}
```

**Important**: `customerId` must equal the profile name (filename without `.json`).

Ports start at 18790 and increment. Check existing manifests:

```bash
grep -r '"port"' customers/*.json
```

## Step 2: Provision Gateway Instance

```bash
bash scripts/provision-customer.sh create acme-corp
```

This creates:

- State directory: `~/.openclaw-acme-corp/`
- Gateway config: `~/.openclaw-acme-corp/openclaw.json`
- Workspace: `~/.openclaw-acme-corp/workspaces/marketing/`
- Skills: 9 core-marketing skills copied to workspace
- LaunchAgent: per-profile macOS service
- Gateway: started on the specified port

## Step 3: Add Telegram Bot Token

```bash
openclaw --profile acme-corp channels add --channel telegram --token '<BOT_TOKEN>'
```

Replace `<BOT_TOKEN>` with the token from @BotFather.

## Step 4: Add API Keys

Write API keys directly to the customer's auth profiles:

```bash
AUTH_DIR=~/.openclaw-acme-corp/agents/main/agent node -e "
const fs = require('fs');
const dir = process.env.AUTH_DIR;
fs.mkdirSync(dir, { recursive: true });
const path = dir + '/auth-profiles.json';
const store = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
store.profiles = store.profiles || {};
const norm = (s) => s.trim().replace(/[^\x20-\x7E]/g, '');
// Add at least one chain-compatible key (Google or OpenRouter)
store.profiles['google:default'] = { type: 'api_key', provider: 'google', key: norm('GOOGLE_API_KEY_HERE') };
store.profiles['openrouter:default'] = { type: 'api_key', provider: 'openrouter', key: norm('OPENROUTER_KEY_HERE') };
fs.writeFileSync(path, JSON.stringify(store, null, 2));
console.log('Auth profiles written');
"
```

Replace `GOOGLE_API_KEY_HERE` and `OPENROUTER_KEY_HERE` with actual keys.

## Step 5: Restart Gateway

```bash
openclaw --profile acme-corp daemon restart
```

## Step 6: Verify Telegram Pairing

1. **DM the bot** directly from the customer's Telegram account
2. Bot returns a **pairing code** (message is NOT processed yet)
3. **Approve the pairing**:

```bash
openclaw --profile acme-corp pairing approve telegram <CODE>
```

4. **Send another test message** — bot should respond normally

## Step 7: Configure Automated Reports

If the manifest has a `reporting` section:

```bash
bash scripts/configure-customer-crons.sh acme-corp
```

Verify cron jobs:

```bash
openclaw --profile acme-corp cron list
```

## Step 8: Customize Workspace (Optional)

Edit brand knowledge:

```bash
# Brand and audience details
vi ~/.openclaw-acme-corp/workspaces/marketing/memory/brand-and-audience.md

# Agent persona
vi ~/.openclaw-acme-corp/workspaces/marketing/SOUL.md
```

## Step 9: Run First Campaign

Send via Telegram DM to the bot:

> Create a campaign brief for [topic]. Use the campaign-lifecycle skill.

Walk through all 7 phases to validate the setup.

## Step 10: Delivery Confirmation

- [ ] Bot responds to Telegram messages
- [ ] Gateway health: `openclaw --profile acme-corp gateway status --require-rpc`
- [ ] Cron jobs listed: `openclaw --profile acme-corp cron list`
- [ ] First campaign completed or in progress

## Troubleshooting

| Issue               | Fix                                                                            |
| ------------------- | ------------------------------------------------------------------------------ |
| Gateway won't start | `openclaw --profile acme-corp doctor --repair`                                 |
| Bot doesn't respond | Check pairing: `openclaw --profile acme-corp pairing list`                     |
| Skills not found    | Verify: `ls ~/.openclaw-acme-corp/workspaces/marketing/skills/core-marketing/` |
| Auth error          | Check: `cat ~/.openclaw-acme-corp/agents/main/agent/auth-profiles.json`        |
| Port conflict       | Check: `grep -r '"port"' customers/*.json`                                     |
