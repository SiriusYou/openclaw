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

| Field                     | Type     | Description                                               |
| ------------------------- | -------- | --------------------------------------------------------- |
| `customerId`              | string   | Unique identifier (alphanumeric + hyphen)                 |
| `status`                  | enum     | `template`, `active`, `provisioned`, `paused`, `disabled` |
| `port`                    | number   | Gateway port (unique per customer, start at 18790)        |
| `channels`                | string[] | Enabled channel plugins                                   |
| `telegramBotToken`        | object   | Token reference (never plaintext in this file)            |
| `brandName`               | string   | Customer's brand name                                     |
| `audience`                | string   | Target audience description                               |
| `modelProfile`            | object   | LLM model configuration (primary + fallbacks)             |
| `skills`                  | string[] | Enabled skills for this customer                          |
| `sandbox`                 | object   | Sandbox configuration (default: off)                      |
| `tools`                   | object   | Tool access control                                       |
| `hostBoundSkillsDenylist` | string[] | Skills to disable (shared host state)                     |

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
