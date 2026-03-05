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

> **Cold restart** (code/plugin file changes): quit and relaunch the Mac App.
> **Config-only reload** (plugin enable, auth changes): use the Mac App or `scripts/restart-mac.sh`.
> Do not use `pkill` + manual `gateway run` — the Mac App manages the gateway lifecycle.

### Step 1.2: Enable Telegram Plugin & Add Bot Token

Channel providers are extensions that ship disabled by default. Enable and configure:

```bash
# Enable the Telegram plugin (modifies ~/.openclaw/openclaw.json)
openclaw plugins enable telegram

# Reload gateway config to load the plugin (config-only change, no cold restart needed)
# Restart via Mac App or: scripts/restart-mac.sh

# Add the Telegram bot token
openclaw channels add --channel telegram --token "<TELEGRAM_BOT_TOKEN>"
```

### Step 1.3: Channel & Model Probes

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

### Step 1.4: Plugin Verification (temporary debug mode)

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

### Step 1.5: Skill-Audit Block Test (T1)

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

### Step 1.6: sendPolicy Verification (T8)

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
# content-writer needs claw1-content-calendar (-sfn = idempotent, replaces existing)
ln -sfn ~/.openclaw/workspaces/marketing/skills/claw1-content-calendar \
        ~/.openclaw/workspaces/content/skills/claw1-content-calendar

# analyst needs check-analytics
ln -sfn ~/.openclaw/workspaces/marketing/skills/check-analytics \
        ~/.openclaw/workspaces/analytics/skills/check-analytics

# Verify symlinks point to correct targets
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
  --agent main \
  --session isolated \
  --cron "0 18 * * *" \
  --tz "Asia/Shanghai" \
  --message 'Daily cost report. Do NOT use browser tools. List each agent session from today, sum token usage and estimated cost per agent. Flag any agent over $20/day. If no sessions found, report $0. Keep response under 200 words.' \
  --timeout-seconds 300 \
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
  --best-effort-deliver \
  --timeout-seconds 120 \
  --announce --channel telegram --to "<TELEGRAM_CHAT_ID>" \
  --message "Semimonthly skill evolution cycle. You MUST complete ALL steps:

1. INVENTORY: List existing skills in skills/evolved/ to avoid duplicates. Also note the core skills: campaign-brief, content-ab-test, campaign-diagnosis, structured-brainstorm. Also note ClawHub skills: self-evolution, evolution-drift-detector, marketing-strategy-pmm.

2. ANALYZE: Run memory_search('campaign lessons learned') and memory_search('skill gaps') to identify what's missing.

3. DECIDE: Pick the single highest-impact skill gap NOT already covered by existing skills (evolved, core, or ClawHub). Do NOT recreate a skill that already exists.

4. CREATE: Write a new SKILL.md file to skills/evolved/<skill-name>/SKILL.md using the write tool. The file MUST start with YAML frontmatter (---/name/description/---), then include: Purpose and when to use, Safety boundaries, Required retrieval steps (memory_search calls), Step-by-step procedure, Output format template, Quality checklist.

5. VERIFY: Read back the file you just wrote to confirm it exists, has valid YAML frontmatter, and contains all required sections.

6. REPORT: Summarize what you created, why, and what gap it fills.

Do NOT just recommend skills — actually create the file. The skills/evolved/ directory is writable."

# Record system ID:
openclaw cron list --json | jq '.jobs[] | select(.name=="marketing-evolution-semimonthly") | .id'
```

### Step 5.2: Verify All Jobs Listed

```bash
openclaw cron list
# Expected: 5 enabled jobs (cost-daily, brief-daily, reflect-weekly, evolution-semimonthly, gateway-health)
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

| #   | Test                               | Command/Action                          | Pass Criteria      | Result                                                                                       |
| --- | ---------------------------------- | --------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| T1  | skill-audit blocks dangerous write | Instruct agent to write dangerous skill | BLOCKED            | **Pass** — model safety + plugin loaded                                                      |
| T2  | Legitimate skill write allowed     | Write safe skill to evolved/            | Pass + audit log   | **Pass** — fixed via `alsoAllow`                                                             |
| T3  | Provider failover                  | Corrupt primary token, send msg         | Fallback delivers  | **Pass** (2026-03-02 live drill) / **Config-only regression** (2026-03-04, see policy below) |
| T4  | Skill invocation per agent         | Chat with each agent using skill        | No allowlist block | **Pass**                                                                                     |
| T5  | memory_search hits                 | 3 queries across directories            | Non-empty + source | **Pass**                                                                                     |
| T6  | Cron jobs manual trigger           | `cron run` each of 4 jobs               | All succeed        | **Pass**                                                                                     |
| T7  | Full campaign flow                 | brief→content→analysis→feedback         | One pass, no P0    | **Pass** — skill+subagent+feedback chain verified                                            |
| T8  | sendPolicy verification            | Telegram + CLI path                     | Both allowed       | **Pass**                                                                                     |

### T3 Regression Policy

T3 (provider failover) has two verification levels:

- **Full drill** (initial acceptance): corrupt primary auth profile, send message, verify fallback delivers, restore profile. Required on first setup.
- **Config-only** (regression): verify 3-provider chain exists in auth profiles and runtime config, confirm no auth/fallback code paths changed. Sufficient when changes are limited to marketing/analytics content.

**Triggers for mandatory live failover drill:**

- Auth profile changes (new keys, rotated tokens, removed providers)
- Provider or fallback chain configuration changes
- OpenClaw version upgrade (especially major versions)
- Authentication errors observed in production logs

Last full drill: 2026-03-02. Last config-only regression: 2026-03-04 (post-upstream sync).

### Known Issues (2026-03-03)

**T2 Fixed (2026-03-04) — `tools.allow` → `tools.alsoAllow`:**
Root cause: config used `tools.allow` (restrictive allowlist — ONLY those tools) instead of
`tools.alsoAllow` (additive — profile tools PLUS these extras). With `profile: "full"` and
`allow`, only the listed tools were available; base tools (read/write/edit/exec) were blocked.
Fix: renamed `allow` → `alsoAllow` in all 3 agents across both source and runtime configs.
Agent now has full base tools + memory/sessions/clawhub extras.

**T7 Fixed (2026-03-04) — sendPolicy blocked subagent sessions:**
Root cause: `sendPolicy` rule `rawKeyPrefix: "agent:main:main"` was too narrow — it only matched
CLI sessions for the main agent. When main spawned `content-writer` via `sessions_spawn`, the
spawned session key (`agent:content-writer:spawn:...`) didn't match any allow rule, so the
gateway blocked it with `send blocked by session policy`.
Fix: broadened sendPolicy to allow all sessions for configured agents:

- `agent:main:` — main agent CLI, cron, and spawn sessions
- `agent:content-writer:` — content-writer subagent sessions
- `agent:analyst:` — analyst subagent sessions
  Evidence (2026-03-04 16:01 UTC): Telegram inbound → `before_agent_start` hook → main agent
  called `sessions_spawn` (succeeded, 83ms) → spawned agent executed 5 `exec` + 2 `read` tool
  calls → `agent_end` feedback fired on both main and spawned sessions.

**CLI vs Channel Session Tool Access:**

```
CLI sessions (openclaw agent --message):
  tools: sessions_spawn only (often blocked by sendPolicy for non-main agents)

Channel sessions (Telegram inbound):
  tools: per tools.alsoAllow list in agent config
  note: subagent delegation requires sessions_spawn in alsoAllow list
        AND sendPolicy rules for spawned agent session keys
```

---

## Post-Verification Checklist

- [ ] `logging.level` reverted to `"info"` in `~/.openclaw/openclaw.json`
- [ ] Auth-profiles drill backup removed (`*.pre-drill`)
- [ ] All cron job system IDs recorded (environment-specific — retrieve with command below):

```bash
# List all cron IDs (re-run after any environment rebuild)
openclaw cron list --json | jq -r '.jobs[] | "\(.name)\t\(.id)"'
```

- [ ] Runbook validated — all steps reproducible

---

## Troubleshooting

### Gateway Offline

The gateway runs as a Mac App managed LaunchAgent. Common causes of downtime:

1. **Mac sleep/restart** — the app must be relaunched manually after reboot
2. **App crash** — check `~/.openclaw/logs/gateway.err.log` for stack traces
3. **Port conflict** — another process on port 18789

```bash
# Diagnose
openclaw gateway probe                    # reachable?
curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 http://127.0.0.1:18789/health
ss -ltnp | grep 18789 2>/dev/null || lsof -i :18789   # port in use?

# Fix
# Option 1: Relaunch the OpenClaw Mac App (preferred)
# Option 2: Config-only reload via scripts/restart-mac.sh
scripts/restart-mac.sh

# Verify
openclaw gateway probe
openclaw channels status --probe
```

### Cron Job Errors

```bash
# 1. List all jobs and their last status
openclaw cron list

# 2. Check execution history for a specific job
openclaw cron list --json | jq -r '.jobs[] | "\(.name)\t\(.id)"'
openclaw cron runs --id <job-id> --limit 5

# 3. Common error patterns:
#    "cron: job execution timed out" → model inference hung or agent used expensive tools
#      Fix: simplify prompt, add --timeout-seconds, switch to faster agent
#    "FailoverError: LLM request timed out" → provider timeout, check model availability
#      Fix: openclaw models status, verify auth profiles
#    "send blocked by session policy" → spawned session key not in sendPolicy rules
#      Fix: add rawKeyPrefix rule for the agent's session namespace

# 4. Manual trigger to test fix
openclaw cron run <job-id>
openclaw cron runs --id <job-id> --limit 1   # verify status=ok
```

### Logging Level Toggle

```bash
# Temporarily enable debug logging for diagnostics
# Edit ~/.openclaw/openclaw.json → "logging": { "level": "debug" }
# Restart via Mac App or: scripts/restart-mac.sh

# After diagnostics, revert to info
# Edit ~/.openclaw/openclaw.json → "logging": { "level": "info" }
# Restart via Mac App or: scripts/restart-mac.sh

# Debug logs appear in:
#   ~/.openclaw/logs/gateway.log       (gateway-level, summarized)
#   ~/.openclaw/logs/gateway.err.log   (errors and warnings)
#   /tmp/openclaw/openclaw-YYYY-MM-DD.log  (detailed JSON, tool calls, plugin hooks)
```

### Live Drill Trigger Conditions

A failover drill SHOULD be performed when:

- Gateway has been offline for >1 hour unexpectedly
- Auth profile rotation (provider key change)
- After major upstream sync (>100 commits)
- Quarterly (minimum frequency)

Record drill results in `marketing/status/failover-log.md`.

### N7 Production Hardening (2026-03-05)

**Cost alerting**: `marketing-cost-daily` cron updated with 3-tier thresholds:

- NORMAL: ≤$15/day
- WARNING: >$15/day — recommend reviewing model selection
- CRITICAL: >$20/day — recommend pausing non-core crons

**Gateway health monitoring**: `marketing-gateway-health` cron (every 6h → Telegram)

```bash
# System ID (environment-specific):
openclaw cron list --json | jq -r '.jobs[] | select(.name=="marketing-gateway-health") | .id'
```

**Smoke scripts**:

```bash
bash marketing/scripts/acceptance-smoke.sh   # T1/T2/T5/T8 checks (13 assertions)
bash marketing/scripts/cron-smoke.sh          # 5 cron existence + status
```

**Plugin regression tests**:

```bash
bunx vitest run test/marketing/   # 31 tests: skill-audit (15) + marketing-feedback (16)
```

**Backup system**: daily 3:00AM snapshots to `~/.openclaw/backups/YYYY-MM-DD/`

- Scope: openclaw.json, auth-profiles, evolved skills, marketing memory
- Retention: 30 days
- Deploy: `setup.sh` step 8b (or manually: `bash marketing/scripts/daily-backup.sh`)
- Verify: `bash marketing/scripts/daily-backup.sh --dry-run`

**Log rotation**: `bash marketing/scripts/log-rotate.sh` (14-day retention on `/tmp/openclaw/`)

**Status tracking**:

- Weekly health snapshot: `marketing/status/weekly-status.md`
- Failover drill log: `marketing/status/failover-log.md`

### Config Change Checklist

When editing `marketing/openclaw.json` (source config):

1. Make the change in source: `marketing/openclaw.json`
2. Apply the same change to runtime: `~/.openclaw/openclaw.json`
3. Restart gateway: via Mac App or `scripts/restart-mac.sh`
4. Verify: `openclaw gateway probe`
5. Commit source change to git

> **Why both?** `setup.sh` only copies source → runtime on first run.
> Subsequent edits to source alone do NOT update the running gateway.
