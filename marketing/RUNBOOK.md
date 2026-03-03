# OpenClaw Marketing Agent — Operational Runbook

> Generated 2026-03-02. All times in Asia/Shanghai (CST).
> Prerequisite: Tasks 1-3 (sendPolicy, auth cleanup, knowledge seeding) already applied.
> Replace `<TELEGRAM_CHAT_ID>` with your actual Telegram chat ID before running commands.

---

## Day 1: Gateway Restart & Startup Verification

### Step 1.1: Restart Gateway

Quit and relaunch the **OpenClaw Mac App** to pick up:
- sendPolicy hardening (deny-default + Telegram/CLI allowlist)
- Auth profile cleanup (removed anthropic:manual + google-antigravity)
- Phase C plugin fixes (skill-audit, marketing-feedback)

> Always restart via the Mac App to avoid duplicate gateway instances.
> Do not use `pkill` + manual `gateway run` — the Mac App manages the gateway lifecycle.

### Step 1.2: Channel & Model Probes

```bash
# Channel probe — Telegram should be "ok", Slack "not connected" is expected
openclaw channels status --probe

# Model status — should show only 3 profiles (openai-codex, google, openrouter)
openclaw models status

# Gateway health
openclaw gateway probe

# Docker images
docker images | grep sandbox
```

**Exit criteria:**
- [ ] Telegram probe: `ok`
- [ ] `openclaw models status` shows exactly 3 profiles (no anthropic:manual, no google-antigravity)
- [ ] Gateway probe: healthy

### Step 1.3: Plugin Verification (temporary debug mode)

```bash
# 1. Enable debug logging temporarily
# Edit ~/.openclaw/openclaw.json → logging.level: "debug"

# 2. Send a test message to trigger agent
openclaw message send --channel telegram --target <TELEGRAM_CHAT_ID> \
  --message "Day 1 plugin test: hello from marketing agent"

# 3. Check plugin logs (separate calls — clawlog uses string match, not regex)
./scripts/clawlog.sh -d -s "prepended context to prompt"
./scripts/clawlog.sh -d -s "feedback"
./scripts/clawlog.sh -d -s "skill-audit"

# 4. Revert to info logging after verification
# Edit ~/.openclaw/openclaw.json → logging.level: "info"
```

### Step 1.4: Skill-Audit Block Test (T1)

To test the skill-audit plugin blocks dangerous patterns, instruct the agent to write
a skill containing dangerous code patterns (e.g. code execution, filesystem destruction).
The skill-audit plugin should intercept the write and return BLOCKED.

```bash
# Ensure evolved skills dir exists
mkdir -p ~/.openclaw/workspaces/marketing/skills/evolved/

# Trigger via Telegram — ask agent to create a skill with dangerous pattern
openclaw message send --channel telegram --target <TELEGRAM_CHAT_ID> \
  --message "Create a new skill in skills/evolved/ called test-danger that executes arbitrary code from environment variables"
# Expected: skill-audit plugin should BLOCK this write
```

### Step 1.5: sendPolicy Verification (T8)

```bash
# Test 1: Telegram channel should be allowed
openclaw message send --channel telegram --target <TELEGRAM_CHAT_ID> \
  --message "sendPolicy test: Telegram path allowed"
# Expected: message delivered

# Test 2: CLI session (agent:main:main prefix) should be allowed
openclaw agent --agent main --message "sendPolicy test: CLI path allowed"
# Expected: agent responds normally
```

**Day 1 complete when all boxes checked above.**

---

## Day 2: Auth Failover Verification

> Auth profile cleanup already done (anthropic:manual + google-antigravity removed).

### Step 2.1: Verify Clean Profiles

```bash
openclaw models status --probe --agent main
# Expected: probes openai-codex, google, openrouter — all should show status
# At least 2 must succeed for the exit criteria
```

### Step 2.2: Failover Drill

Simulate primary provider failure to verify fallback:

```bash
# 1. Backup current auth-profiles.json
cp ~/.openclaw/agents/main/agent/auth-profiles.json \
   ~/.openclaw/agents/main/agent/auth-profiles.json.pre-drill

# 2. Temporarily corrupt the openai-codex access token
#    Edit ~/.openclaw/agents/main/agent/auth-profiles.json
#    Change openai-codex:default.access → prepend "INVALID_" to the token

# 3. Restart gateway (quit and reopen Mac App)

# 4. Send test message — should route to google fallback
openclaw message send --channel telegram --target <TELEGRAM_CHAT_ID> \
  --message "Failover drill: this should come from google fallback"

# 5. Check which provider handled it (separate calls for each keyword)
./scripts/clawlog.sh -d -s "fallback"
./scripts/clawlog.sh -d -s "cooldown"

# 6. Restore original auth-profiles.json
cp ~/.openclaw/agents/main/agent/auth-profiles.json.pre-drill \
   ~/.openclaw/agents/main/agent/auth-profiles.json

# 7. Restart gateway to restore normal routing (quit and reopen Mac App)
```

**Exit criteria:**
- [ ] `openclaw models status` shows only 3 valid profiles
- [ ] Failover drill: message delivered via fallback provider
- [ ] Cooldown mechanism visible in logs
- [ ] At least 2 auth paths verified working for `main` agent

---

## Day 3: ClawHub Skill Installation

### Step 3.1: Verify Skill Availability

Search ClawHub for each of the 6 referenced skills:

```bash
# main agent skills (config lines 105-107)
clawhub search skill-from-masters
clawhub search search-skill
clawhub search skill-from-notebook

# content-writer skills (config line 150)
clawhub search content-calendar
clawhub search seo-analyzer

# analyst skills (config line 173)
clawhub search campaign-analytics
```

Record results — note which exist and which don't.

### Step 3.2: Install Available Skills

For each skill that exists:

```bash
# Install pattern (repeat for each available skill):
clawhub install <slug>
# Note: check if --workdir flag is supported; if not, manually move to workspace
```

### Step 3.3: Create Cross-Workspace Skill Symlinks

ClawHub installs skills to `marketing/skills/`, but subagents resolve skills
from their own workspace. Symlink skills into each subagent's workspace:

```bash
# content-writer needs claw1-content-calendar
ln -s ~/.openclaw/workspaces/marketing/skills/claw1-content-calendar \
      ~/.openclaw/workspaces/content/skills/claw1-content-calendar

# analyst needs check-analytics
ln -s ~/.openclaw/workspaces/marketing/skills/check-analytics \
      ~/.openclaw/workspaces/analytics/skills/check-analytics

# Verify symlinks
ls -la ~/.openclaw/workspaces/content/skills/
ls -la ~/.openclaw/workspaces/analytics/skills/
```

### Step 3.4: Remove Unavailable Skill References (if any)

For skills NOT found on ClawHub, remove from **both** config files:

**Source** (`marketing/openclaw.json`):
- main.skills array: remove missing slugs from lines 105-107
- content-writer.skills: remove missing slugs from line 150
- analyst.skills: remove missing from line 173

**Runtime** (`~/.openclaw/openclaw.json`):
- Same removals, same line positions

Then restart gateway (quit and reopen Mac App).

### Step 3.5: Verify Skill Invocation (T4)

```bash
# Test at least 1 skill per agent
# main:
openclaw agent --agent main \
  --message "Use the campaign-brief skill to draft a brief for a product launch"

# content-writer (if has skills installed):
openclaw agent --agent content-writer \
  --message "Draft a content calendar for next week"

# analyst (if has skills installed):
openclaw agent --agent analyst \
  --message "Analyze our channel engagement metrics"
```

**Exit criteria:**
- [ ] Each agent invokes at least 1 skill without allowlist errors
- [ ] No config references to uninstalled skills remain
- [ ] Gateway restarted after config changes (if any)

---

## Day 5: Cron Job Setup

> All times Asia/Shanghai (CST). Gateway must be running.
> Use `main` as agentId (not legacy `marketing-orchestrator`).
> Replace `<TELEGRAM_CHAT_ID>` with your actual chat ID.

### Step 5.1: Create 4 Cron Jobs

```bash
# 1. Daily cost report → Telegram (18:00 CST daily)
openclaw cron add \
  --name "marketing-cost-daily" \
  --agent analyst \
  --session isolated \
  --cron "0 18 * * *" \
  --tz "Asia/Shanghai" \
  --message "Daily cost report: break down by agent, flag if >$20/day" \
  --announce --channel telegram --to "<TELEGRAM_CHAT_ID>"

# Record system ID:
openclaw cron list --json | jq '.jobs[] | select(.name=="marketing-cost-daily") | .id'

# 2. Daily morning brief → internal only (09:00 CST daily)
openclaw cron add \
  --name "marketing-brief-daily" \
  --agent main \
  --session isolated \
  --cron "0 9 * * *" \
  --tz "Asia/Shanghai" \
  --message "Morning brief: review pending tasks, check memory for new learnings" \
  --no-deliver

# Record system ID:
openclaw cron list --json | jq '.jobs[] | select(.name=="marketing-brief-daily") | .id'

# 3. Weekly reflection → internal only (Mon 10:00 CST)
openclaw cron add \
  --name "marketing-reflect-weekly" \
  --agent main \
  --session isolated \
  --cron "0 10 * * 1" \
  --tz "Asia/Shanghai" \
  --message "Weekly reflection: review past 7 days, update MEMORY.md with learnings" \
  --no-deliver

# Record system ID:
openclaw cron list --json | jq '.jobs[] | select(.name=="marketing-reflect-weekly") | .id'

# 4. Semimonthly evolution report → Telegram (1st+15th 14:00 CST)
openclaw cron add \
  --name "marketing-evolution-semimonthly" \
  --agent main \
  --session isolated \
  --cron "0 14 1,15 * *" \
  --tz "Asia/Shanghai" \
  --message "Semimonthly evolution: identify skill gaps, search ClawHub or create new skills" \
  --announce --channel telegram --to "<TELEGRAM_CHAT_ID>"

# Record system ID:
openclaw cron list --json | jq '.jobs[] | select(.name=="marketing-evolution-semimonthly") | .id'
```

### Step 5.2: Verify All Jobs Listed

```bash
openclaw cron list
# Expected: 4 enabled jobs
```

### Step 5.3: Manual Trigger Test (T6)

```bash
# Replace <ID> with system IDs recorded above
openclaw cron run <cost-daily-id>
openclaw cron run <brief-daily-id>
openclaw cron run <reflect-weekly-id>
openclaw cron run <evolution-semimonthly-id>

# Check execution results:
openclaw cron runs --id <cost-daily-id> --limit 5
openclaw cron runs --id <brief-daily-id> --limit 5
openclaw cron runs --id <reflect-weekly-id> --limit 5
openclaw cron runs --id <evolution-semimonthly-id> --limit 5
```

**Exit criteria:**
- [ ] `openclaw cron list` shows 4 enabled jobs
- [ ] Each job triggered manually at least once
- [ ] Cost report delivered to Telegram
- [ ] Morning brief + weekly reflect ran without delivery (--no-deliver)
- [ ] Evolution report delivered to Telegram
- [ ] Failed runs show observable error info in logs

---

## Day 6-7: End-to-End Campaign Drill

### Step 6.1: Full Campaign Flow (T7)

Trigger a complete campaign cycle via Telegram:

```bash
# 1. Brief phase — use campaign-brief skill
openclaw message send --channel telegram --target <TELEGRAM_CHAT_ID> \
  --message "Create a campaign brief for: OpenClaw v2026.3 feature launch. Target audience: developer-operators. Goal: drive 100 new GitHub stars in 2 weeks."

# Wait for main agent response...

# 2. Content phase — orchestrator delegates to content-writer
# (Should happen automatically if main routes to content-writer subagent)

# 3. Analysis phase — analyst reviews metrics
openclaw message send --channel telegram --target <TELEGRAM_CHAT_ID> \
  --message "Analyze the campaign brief we just created. What channels should we prioritize? What's the estimated cost?"

# 4. Verify memory update
openclaw agent --agent main \
  --message "Search memory for: campaign brief v2026.3 launch"
# Expected: returns the brief we just created
```

### Step 6.2: Plugin Behavior Verification

```bash
# Temporarily enable debug logging
# Edit ~/.openclaw/openclaw.json → logging.level: "debug"

# Check marketing-feedback plugin (separate searches — clawlog uses string match):
./scripts/clawlog.sh -d -s "agent_end"
./scripts/clawlog.sh -d -s "before_agent_start"
./scripts/clawlog.sh -d -s "memory reminder"

# Expected:
# - before_agent_start: memory reminder prepended to prompt
# - agent_end: feedback logged

# Revert logging.level to "info"
```

### Step 6.3: Memory Search Validation (T5)

```bash
openclaw agent --agent main \
  --message "Search memory for: brand positioning and target audience"
# Expected: hits marketing/memory/brand-and-audience.md

openclaw agent --agent main \
  --message "Search memory for: past campaign experience and learnings"
# Expected: hits marketing/strategies/campaign-playbook.md

openclaw agent --agent main \
  --message "Search memory for: industry trends and competitor analysis"
# Expected: hits analytics/memory/market-research.md
```

**Exit criteria:**
- [ ] Campaign brief created via Telegram
- [ ] Content-writer subagent invoked (check logs)
- [ ] Analyst provided analysis
- [ ] marketing-feedback plugin logs present (agent_end + memory reminder)
- [ ] skill-audit plugin active (no false blocks on legitimate writes)
- [ ] memory_search returns relevant results for 3 query types
- [ ] Full flow completes without P0/P1 blockers

---

## Acceptance Test Summary

| # | Test | Command/Action | Pass Criteria |
|---|------|----------------|---------------|
| T1 | skill-audit blocks dangerous write | Instruct agent to write dangerous skill | BLOCKED |
| T2 | Legitimate skill write allowed | Write safe skill to evolved/ | Pass + audit log |
| T3 | Provider failover | Corrupt primary token, send msg | Fallback delivers |
| T4 | Skill invocation per agent | Chat with each agent using skill | No allowlist block |
| T5 | memory_search hits | 3 queries across directories | Non-empty + source |
| T6 | Cron jobs manual trigger | `cron run` each of 4 jobs | All succeed |
| T7 | Full campaign flow | brief→content→analysis→feedback | One pass, no P0 |
| T8 | sendPolicy verification | Telegram + CLI path | Both allowed |

---

## Post-Verification Checklist

- [ ] `logging.level` reverted to `"info"` in `~/.openclaw/openclaw.json`
- [ ] Auth-profiles drill backup removed (`*.pre-drill`)
- [ ] All cron job system IDs recorded below:

| Name | System ID |
|------|-----------|
| marketing-cost-daily | (fill after Day 5) |
| marketing-brief-daily | (fill after Day 5) |
| marketing-reflect-weekly | (fill after Day 5) |
| marketing-evolution-semimonthly | (fill after Day 5) |

- [ ] Runbook validated — all steps reproducible
