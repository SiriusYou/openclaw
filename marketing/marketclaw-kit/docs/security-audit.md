# Security Audit Report — Multi-Customer Isolation (M6)

> **Date**: 2026-03-20
> **Scope**: macOS single-operator deployment with `--profile` isolation
> **Trust model**: Same operator user, per-customer gateway instances, no OS-user separation (Phase 1)

---

## 1. Isolation Model

Each customer runs as an independent gateway instance via `openclaw --profile {id}`.
Profile isolation provides:

- Independent config file (`~/.openclaw-{id}/openclaw.json`)
- Independent state directory (`~/.openclaw-{id}/`)
- Independent gateway process (unique port, separate LaunchAgent)
- Independent auth credentials (`~/.openclaw-{id}/agents/main/agent/auth-profiles.json`)
- Independent workspace (`~/.openclaw-{id}/workspaces/marketing/`)
- Independent session transcripts (`~/.openclaw-{id}/agents/main/sessions/`)

**This is operational isolation, not strict multi-tenant isolation.** All profiles run under the same macOS user account.

---

## 2. Confirmed Isolated Boundaries

| Boundary            | Path Pattern                                            | Isolation Mechanism                                                                          | Status   |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| State directory     | `~/.openclaw-{id}/`                                     | `--profile` resolves `OPENCLAW_STATE_DIR` (`src/cli/profile.ts:113-121`)                     | Verified |
| Config file         | `~/.openclaw-{id}/openclaw.json`                        | Per-profile state dir                                                                        | Verified |
| Auth profiles       | `~/.openclaw-{id}/agents/main/agent/auth-profiles.json` | Per-profile state dir                                                                        | Verified |
| OAuth credentials   | `~/.openclaw-{id}/credentials/oauth.json`               | `resolveOAuthPath()` uses `$OPENCLAW_STATE_DIR` (`src/config/paths.ts:230-251`)              | Verified |
| Gateway port        | Per-profile `gateway.port`                              | Unique port per config                                                                       | Verified |
| LaunchAgent         | `ai.openclaw.{id}` label                                | Per-profile service; stdout/stderr scoped (`src/daemon/launchd.ts:58-69`)                    | Verified |
| Workspace           | `~/.openclaw-{id}/workspaces/marketing/`                | Per-profile state dir                                                                        | Verified |
| Session transcripts | `~/.openclaw-{id}/agents/main/sessions/`                | Per-profile state dir                                                                        | Verified |
| Cost data           | Session transcripts path                                | `loadCostUsageSummary()` reads from active state dir (`src/infra/session-cost-usage.ts:316`) | Verified |
| FS tool boundary    | `tools.fs.workspaceOnly: true`                          | Per-agent enforcement                                                                        | Verified |
| Cron jobs           | Per-gateway `cron/jobs.json`                            | Each gateway manages its own cron store                                                      | Verified |

---

## 3. Shared Boundaries (Cross-Profile, Not Isolated)

| Shared Resource         | Path                              | Risk                                         | Mitigation                                                                          | Residual Risk                                  |
| ----------------------- | --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| exec-approvals.json     | `~/.openclaw/exec-approvals.json` | Cross-profile allowlist conflict             | **Mitigated**: all customers have `exec.security: "deny"`, no approvals are written | None (as long as exec=deny is maintained)      |
| exec-approvals.sock     | `~/.openclaw/exec-approvals.sock` | Cross-profile approval interception          | **Mitigated**: customers have exec=deny, socket unused                              | None                                           |
| Gateway lock dir        | `/tmp/openclaw-<uid>/`            | Lock contention between profiles             | **Low risk**: locks are process-level, don't affect data isolation                  | Negligible                                     |
| Application rolling log | `/tmp/openclaw/openclaw-*.log`    | Customer operation logs mixed in single file | **Known limitation** (see Section 4)                                                | Medium — info-level logs from all profiles mix |

---

## 4. Known Limitation: Rolling Log Mixing

**Issue**: The application logger (`src/logging/logger.ts:34-45, 346-348`) writes to a global temp directory `/tmp/openclaw/openclaw-YYYY-MM-DD.log`. All profile gateway processes write to the same file.

**What is NOT affected**:

- LaunchAgent stdout/stderr — already profile-scoped (`src/daemon/launchd.ts:58-69`, output to `<stateDir>/logs/`)
- Structured gateway logs — stored in profile state dir

**What IS affected**:

- The rolling application log at `/tmp/openclaw/` — contains info/warn/error/fatal level entries from ALL profiles

**Mitigations in place**:

1. `logging.redactSensitive: "tools"` ensures sensitive tool output is redacted even in mixed logs
2. LaunchAgent stdout/stderr is isolated (structured gateway logs per-profile)
3. Rolling log contains info+ level only (`src/logging/levels.ts:25`, `levelToMinLevel()`)
4. `log-rotate.sh` applies 14-day retention to limit exposure window

**Why not fixed in Phase 1**:

- `logging.file` config (`src/config/types.base.ts:168`) accepts a fixed path, but setting it breaks date-based rolling and auto-cleanup (`src/logging/logger.ts:178-182, 346-348`)
- Making `defaultRollingPathForToday()` profile-aware requires upstream code changes

**Remediation path (future)**:

- Request upstream: read `OPENCLAW_STATE_DIR` in `defaultRollingPathForToday()` to produce per-profile rolling logs
- Or: add date-template variable support to `logging.file` config

---

## 5. Security Posture Per Customer

Every customer gateway is provisioned with:

| Setting                      | Value                      | Purpose                                                          |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `sandbox.mode`               | `"off"`                    | Customers interact via Telegram only; skills curated by operator |
| `tools.exec.security`        | `"deny"`                   | No shell execution — prevents arbitrary command injection        |
| `tools.fs.workspaceOnly`     | `true`                     | FS tools restricted to workspace directory                       |
| `session.sendPolicy.default` | `"deny"`                   | Explicit send rules required per session type                    |
| `gateway.bind`               | `"loopback"`               | Gateway only listens on localhost                                |
| `agents.list`                | `["main"]` only            | Single agent, no subagents                                       |
| `skills.entries`             | Host-bound skills disabled | `things-mac`, `tmux`, `1password` explicitly `enabled: false`    |

**Model chain validation**: All providers in `modelProfile` (primary + fallbacks) must be from the approved namespace: `openai-codex`, `google`, `openrouter`.

---

## 6. Exec-Approvals Constraint

`~/.openclaw/exec-approvals.json` is a **shared file** across all profiles (`src/infra/exec-approvals.ts:153-165`). Entries are keyed by `agentId`, and all profiles use `main` as the agent ID.

**Current mitigation**: All customer profiles have `exec.security: "deny"`, so no approval entries are created. The shared file is never written to by customer gateways.

**Risk if changed**: Switching any customer to `exec.security: "allowlist"` would cause cross-profile approval conflicts. Do not change without:

1. Upstream support for profile-scoped approvals, OR
2. Migration to Linux with independent OS users

---

## 7. Incident Response

### If a customer profile is compromised:

1. **Immediate**: `openclaw --profile {id} gateway stop` — halt the gateway
2. **Assess**: Check `/tmp/openclaw/openclaw-*.log` for cross-profile activity (note: logs are mixed)
3. **Contain**: `provision-customer.sh pause {id}` — update manifest + stop service
4. **Export**: `provision-customer.sh export {id}` — preserve evidence
5. **Rotate**: Regenerate API keys in the compromised profile's `auth-profiles.json`
6. **Verify other profiles**: Run `security-check.sh --all` to confirm no cross-contamination

### Blast radius (same macOS user):

- **Contained to profile**: config, state, workspace, sessions, auth, cron
- **NOT contained**: rolling log at `/tmp/openclaw/` (read-only risk), process-level signals (same user)
- **Theoretical escalation**: same macOS user can read all profile directories. This is the accepted Phase 1 trade-off. Linux with independent OS users eliminates this.

---

## 8. Upgrade Path: Linux Strong Isolation

| Phase 1 (macOS)                      | Future (Linux)                                   |
| ------------------------------------ | ------------------------------------------------ |
| Same OS user, `--profile` isolation  | Independent OS users per customer                |
| Shared `/tmp/openclaw/` logs         | Per-user log directories                         |
| No file permission enforcement       | `chmod 700` on state dirs                        |
| Shared exec-approvals.json           | Per-user file (different `$HOME`)                |
| LaunchAgent (requires login session) | systemd user services + `loginctl enable-linger` |

---

## 9. Automated Validation

- **Static**: `security-posture.test.ts` (in monorepo test suite) — validates manifest security fields + provisioning output
- **Runtime**: `scripts/security-check.sh` — validates live profile security posture
- **Continuous**: `scripts/customer-status.sh` — aggregated view of all customer health + cost + backup status

---

## 10. Audit Checklist Summary

| #   | Check                                                   | Result                                                    |
| --- | ------------------------------------------------------- | --------------------------------------------------------- |
| 1   | State directory isolation                               | PASS                                                      |
| 2   | Config file isolation                                   | PASS                                                      |
| 3   | Auth profile isolation                                  | PASS                                                      |
| 4   | OAuth credential isolation                              | PASS                                                      |
| 5   | Gateway port uniqueness                                 | PASS                                                      |
| 6   | LaunchAgent isolation                                   | PASS                                                      |
| 7   | Workspace isolation                                     | PASS                                                      |
| 8   | Session/cost data isolation                             | PASS                                                      |
| 9   | exec-approvals.json shared                              | KNOWN — mitigated by exec=deny                            |
| 10  | Rolling log shared                                      | KNOWN — mitigated by redaction + structured logs isolated |
| 11  | Customer security posture (exec deny, fs workspaceOnly) | PASS                                                      |
| 12  | Model chain provider allowlist                          | PASS                                                      |
| 13  | Host-bound skills blocked                               | PASS                                                      |
| 14  | No plaintext secrets in manifests                       | PASS                                                      |

**Overall assessment**: Isolation is sufficient for Phase 1 (same-operator, same-trust-boundary deployment). Known limitations are documented with mitigations in place. Upgrade to Linux strong isolation recommended for untrusted multi-tenant scenarios.
