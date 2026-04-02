import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadManifests } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test-only: execSync is safe here — all commands are controlled test scripts,
// not user input. The security hook warning about exec() does not apply.
// This follows the same pattern as provision-customer.test.ts.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CUSTOMERS_DIR = path.join(REPO_ROOT, "marketing/customers");
const SHIM_PATH = path.join(REPO_ROOT, "test/scripts/openclaw-shim.sh");

/** Approved provider namespaces for customer model chains. */
const APPROVED_PROVIDERS = ["openai-codex", "google", "openrouter", "minimax"];

/** Host-bound skills that must be denied for customers. */
const REQUIRED_HOST_DENY = ["things-mac", "tmux", "1password"];

let tmpDir: string;
let shimBinDir: string;
let shimStateDir: string;

function run(cmd: string): string {
  const env = {
    ...process.env,
    PATH: `${shimBinDir}:${process.env.PATH}`,
    HOME: tmpDir,
    OPENCLAW_SHIM_STATE_DIR: shimStateDir,
  };
  return execSync(cmd, {
    env,
    cwd: REPO_ROOT,
    timeout: 30_000,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function createManifest(id: string, overrides: Record<string, unknown> = {}): void {
  const manifest = {
    customerId: id,
    status: "template",
    port: 18795,
    channels: ["telegram"],
    telegramBotToken: { ref: `env:TOKEN_${id.toUpperCase()}` },
    brandName: `${id} Brand`,
    audience: `${id} audience`,
    modelProfile: {
      primary: "google/gemini-3-pro-preview",
      fallbacks: ["openrouter/auto"],
    },
    skills: ["campaign-brief", "campaign-lifecycle"],
    sandbox: { mode: "off" },
    tools: {
      profile: "full",
      fs: { workspaceOnly: true },
      exec: { security: "deny" },
    },
    hostBoundSkillsDenylist: ["things-mac", "tmux", "1password"],
    ...overrides,
  };
  const dir = path.join(tmpDir, "marketing/customers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest, null, 2));
}

function readConfig(id: string): Record<string, unknown> {
  const p = path.join(tmpDir, `.openclaw-${id}`, "openclaw.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-posture-"));

  shimStateDir = path.join(tmpDir, "shim-state");
  fs.mkdirSync(shimStateDir, { recursive: true });

  shimBinDir = path.join(tmpDir, "bin");
  fs.mkdirSync(shimBinDir);
  fs.symlinkSync(SHIM_PATH, path.join(shimBinDir, "openclaw"));

  // Build minimal marketing/ structure
  const marketingDir = path.join(tmpDir, "marketing");
  const customersDir = path.join(marketingDir, "customers");
  fs.mkdirSync(customersDir, { recursive: true });
  fs.mkdirSync(path.join(marketingDir, "exports"), { recursive: true });

  fs.copyFileSync(
    path.join(REPO_ROOT, "marketing/customers/example.json"),
    path.join(customersDir, "example.json"),
  );

  // Copy workspace source skills
  const srcSkills = path.join(REPO_ROOT, "marketing/workspaces/marketing/skills");
  if (fs.existsSync(srcSkills)) {
    fs.cpSync(srcSkills, path.join(marketingDir, "workspaces/marketing/skills"), {
      recursive: true,
    });
  }

  // Copy scripts
  const scriptsDir = path.join(marketingDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const name of ["provision-customer.sh", "customer-status.sh"]) {
    const src = path.join(REPO_ROOT, "marketing/scripts", name);
    const dst = path.join(scriptsDir, name);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }

  // Provision a test customer for config output assertions
  createManifest("sec-test", { port: 18795 });
  const script = path.join(tmpDir, "marketing/scripts/provision-customer.sh");
  run(`bash "${script}" create sec-test --force`);
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Manifest-layer security assertions (all manifests in marketing/customers/)
// ---------------------------------------------------------------------------

describe("Manifest security posture", () => {
  const manifests = loadManifests(CUSTOMERS_DIR);
  const nonTemplates = manifests.filter((m) => m.data.status !== "template");

  test("all non-template manifests have sandbox.mode === 'off'", () => {
    for (const m of nonTemplates) {
      const sandbox = m.data.sandbox as Record<string, unknown> | undefined;
      expect(sandbox?.mode, `${m.name}: sandbox.mode`).toBe("off");
    }
  });

  test("all non-template manifests have tools.exec.security === 'deny'", () => {
    for (const m of nonTemplates) {
      const tools = m.data.tools as Record<string, Record<string, unknown>> | undefined;
      expect(tools?.exec?.security, `${m.name}: tools.exec.security`).toBe("deny");
    }
  });

  test("all non-template manifests have tools.fs.workspaceOnly === true", () => {
    for (const m of nonTemplates) {
      const tools = m.data.tools as Record<string, Record<string, unknown>> | undefined;
      expect(tools?.fs?.workspaceOnly, `${m.name}: tools.fs.workspaceOnly`).toBe(true);
    }
  });

  test("all manifests (including template) have hostBoundSkillsDenylist", () => {
    for (const m of manifests) {
      const denylist = m.data.hostBoundSkillsDenylist as string[] | undefined;
      expect(denylist, `${m.name}: hostBoundSkillsDenylist must exist`).toBeDefined();
      for (const skill of REQUIRED_HOST_DENY) {
        expect(denylist, `${m.name}: must deny ${skill}`).toContain(skill);
      }
    }
  });

  test("all manifests have only approved model providers", () => {
    for (const m of manifests) {
      const profile = m.data.modelProfile as { primary: string; fallbacks?: string[] } | undefined;
      if (!profile) {
        continue;
      }

      // Check primary
      const primaryProvider = profile.primary.split("/")[0];
      expect(
        APPROVED_PROVIDERS,
        `${m.name}: primary provider '${primaryProvider}' not approved`,
      ).toContain(primaryProvider);

      // Check fallbacks
      for (const fb of profile.fallbacks || []) {
        const fbProvider = fb.split("/")[0];
        expect(
          APPROVED_PROVIDERS,
          `${m.name}: fallback provider '${fbProvider}' not approved`,
        ).toContain(fbProvider);
      }
    }
  });

  test("no plaintext tokens or keys in manifests", () => {
    const secretPatterns = [
      /sk_[a-zA-Z0-9]{20,}/,
      /ghp_[a-zA-Z0-9]{36}/,
      /gho_[a-zA-Z0-9]{36}/,
      /\d{10}:[A-Za-z0-9_-]{35}/, // Telegram bot token format
      /AIza[0-9A-Za-z_-]{35}/, // Google API key
    ];

    for (const m of manifests) {
      const raw = fs.readFileSync(m.path, "utf8");
      for (const pattern of secretPatterns) {
        expect(pattern.test(raw), `${m.name}: contains plaintext secret matching ${pattern}`).toBe(
          false,
        );
      }
    }
  });

  test("skills lists contain only known core-marketing skills", () => {
    const coreSkillsDir = path.join(
      REPO_ROOT,
      "marketing/workspaces/marketing/skills/core-marketing",
    );
    const availableSkills = fs.existsSync(coreSkillsDir)
      ? fs
          .readdirSync(coreSkillsDir)
          .filter((d) => fs.statSync(path.join(coreSkillsDir, d)).isDirectory())
      : [];

    for (const m of manifests) {
      const skills = m.data.skills as string[] | undefined;
      if (!skills) {
        continue;
      }
      for (const skill of skills) {
        expect(availableSkills, `${m.name}: skill '${skill}' not in core-marketing/`).toContain(
          skill,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Provisioning output security assertions (generated runtime config)
// ---------------------------------------------------------------------------

describe("Provisioning output security posture", () => {
  test("generated config has sendPolicy.default === 'deny'", () => {
    const config = readConfig("sec-test");
    const session = config.session as Record<string, Record<string, unknown>> | undefined;
    expect(session?.sendPolicy?.default, "sendPolicy.default").toBe("deny");
  });

  test("generated config has gateway.bind === 'loopback'", () => {
    const config = readConfig("sec-test");
    const gateway = config.gateway as Record<string, unknown> | undefined;
    expect(gateway?.bind, "gateway.bind").toBe("loopback");
  });

  test("generated config has only 'main' agent", () => {
    const config = readConfig("sec-test");
    const agents = config.agents as Record<string, unknown[]> | undefined;
    const list = agents?.list || [];
    expect(list.length, "agents.list length").toBe(1);
    const agent = list[0] as Record<string, unknown>;
    expect(agent.id, "agent id").toBe("main");
  });

  test("generated config has exec.security === 'deny'", () => {
    const config = readConfig("sec-test");
    const agents = config.agents as Record<string, unknown[]> | undefined;
    const agent = (agents?.list || [])[0] as Record<string, Record<string, unknown>>;
    expect(agent?.tools?.exec?.security, "exec.security in generated config").toBe("deny");
  });

  test("generated config has fs.workspaceOnly === true", () => {
    const config = readConfig("sec-test");
    const agents = config.agents as Record<string, unknown[]> | undefined;
    const agent = (agents?.list || [])[0] as Record<string, Record<string, unknown>>;
    expect(agent?.tools?.fs?.workspaceOnly, "fs.workspaceOnly in generated config").toBe(true);
  });

  test("generated config disables host-bound skills", () => {
    const config = readConfig("sec-test");
    const skills = config.skills as Record<string, Record<string, Record<string, unknown>>>;
    expect(skills?.entries, "skills.entries must exist").toBeDefined();
    for (const skill of REQUIRED_HOST_DENY) {
      expect(skills.entries[skill]?.enabled, `${skill} must be disabled`).toBe(false);
    }
  });

  test("generated config paths only reference own profile", () => {
    const stateDir = path.join(tmpDir, ".openclaw-sec-test");
    const configStr = fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8");

    // Should contain own profile reference
    expect(configStr).toContain(".openclaw-sec-test");

    // Should not reference any other .openclaw-* profile
    const otherProfileRef = configStr.match(/\.openclaw-(?!sec-test[/\\"])[a-zA-Z0-9_-]+/);
    expect(otherProfileRef, "config references another profile").toBeNull();
  });
});
