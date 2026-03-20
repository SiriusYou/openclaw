import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Test-only: execSync is safe here — all commands are controlled test scripts,
// not user input. The security hook warning about exec() does not apply.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SHIM_PATH = path.join(REPO_ROOT, "test/scripts/openclaw-shim.sh");

let tmpDir: string;
let shimStateDir: string;
let shimBinDir: string;
let customersDir: string;

/** Run a shell command in the test environment with shimmed openclaw. */
function run(cmd: string, opts: { expectFail?: boolean } = {}): string {
  const env = {
    ...process.env,
    PATH: `${shimBinDir}:${process.env.PATH}`,
    HOME: tmpDir,
    OPENCLAW_SHIM_STATE_DIR: shimStateDir,
  };

  try {
    return execSync(cmd, {
      env,
      cwd: REPO_ROOT,
      timeout: 30_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    if (opts.expectFail) {
      const err = e as { stdout?: string; stderr?: string };
      return (err.stdout || "") + (err.stderr || "");
    }
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`Command failed: ${cmd}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`, {
      cause: e,
    });
  }
}

/** Create a customer manifest in the test customers dir. */
function createManifest(id: string, overrides: Record<string, unknown> = {}): void {
  const manifest = {
    customerId: id,
    status: "template",
    port: 18790,
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
    hostBoundSkillsDenylist: ["things-mac", "tmux"],
    ...overrides,
  };
  fs.writeFileSync(path.join(customersDir, `${id}.json`), JSON.stringify(manifest, null, 2));
}

function readConfig(id: string): Record<string, unknown> {
  const p = path.join(tmpDir, `.openclaw-${id}`, "openclaw.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readManifest(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(customersDir, `${id}.json`), "utf8"));
}

function provision(args: string, opts: { expectFail?: boolean } = {}): string {
  const script = path.join(tmpDir, "marketing/scripts/provision-customer.sh");
  return run(`bash "${script}" ${args}`, opts);
}

function customerStatus(args = ""): string {
  const script = path.join(tmpDir, "marketing/scripts/customer-status.sh");
  return run(`bash "${script}" ${args}`);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provision-test-"));

  shimStateDir = path.join(tmpDir, "shim-state");
  fs.mkdirSync(shimStateDir, { recursive: true });

  // Symlink shim as 'openclaw' on PATH
  shimBinDir = path.join(tmpDir, "bin");
  fs.mkdirSync(shimBinDir);
  fs.symlinkSync(SHIM_PATH, path.join(shimBinDir, "openclaw"));

  // Build a minimal marketing/ structure in tmpDir
  const marketingDir = path.join(tmpDir, "marketing");
  customersDir = path.join(marketingDir, "customers");
  fs.mkdirSync(customersDir, { recursive: true });
  fs.mkdirSync(path.join(marketingDir, "exports"), { recursive: true });

  // Copy example.json
  fs.copyFileSync(
    path.join(REPO_ROOT, "marketing/customers/example.json"),
    path.join(customersDir, "example.json"),
  );

  // Copy workspace source skills (needed by provision create)
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
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // Clear shim state between tests so each test controls its own gateway state
  for (const f of fs.readdirSync(shimStateDir)) {
    fs.unlinkSync(path.join(shimStateDir, f));
  }
});

/** Ensure a customer is provisioned (idempotent — skips if state dir exists). */
function ensureProvisioned(id: string, port: number): void {
  const stateDir = path.join(tmpDir, `.openclaw-${id}`);
  if (fs.existsSync(stateDir)) return;
  createManifest(id, { port });
  provision(`create ${id} --force`);
}

// ---------------------------------------------------------------------------
// #1 + #4: Config/state/workspace isolation
// ---------------------------------------------------------------------------

describe("#1 #4: Config and path isolation", () => {
  test("two customers get independent state dirs and configs", () => {
    createManifest("alpha", { port: 18790 });
    createManifest("bravo", { port: 18791 });

    provision("create alpha --force");
    provision("create bravo --force");

    const alphaDir = path.join(tmpDir, ".openclaw-alpha");
    const bravoDir = path.join(tmpDir, ".openclaw-bravo");
    expect(fs.existsSync(alphaDir)).toBe(true);
    expect(fs.existsSync(bravoDir)).toBe(true);

    const alphaConfig = readConfig("alpha");
    const bravoConfig = readConfig("bravo");

    // Ports differ
    expect((alphaConfig.gateway as Record<string, unknown>).port).toBe(18790);
    expect((bravoConfig.gateway as Record<string, unknown>).port).toBe(18791);

    // Workspace paths reference own profile, not the other
    const alphaAgent = (
      (alphaConfig.agents as Record<string, unknown>).list as Array<Record<string, unknown>>
    )[0];
    const bravoAgent = (
      (bravoConfig.agents as Record<string, unknown>).list as Array<Record<string, unknown>>
    )[0];

    expect(alphaAgent.workspace as string).toContain(".openclaw-alpha");
    expect(alphaAgent.workspace as string).not.toContain("bravo");
    expect(bravoAgent.workspace as string).toContain(".openclaw-bravo");
    expect(bravoAgent.workspace as string).not.toContain("alpha");
  });

  test("alpha files never reference bravo paths or port", () => {
    ensureProvisioned("alpha", 18790);
    ensureProvisioned("bravo", 18791);
    const alphaDir = path.join(tmpDir, ".openclaw-alpha");

    function scanDir(dir: string): string {
      let content = "";
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          content += scanDir(full);
        } else {
          try {
            content += fs.readFileSync(full, "utf8");
          } catch {
            // skip binary
          }
        }
      }
      return content;
    }

    const allContent = scanDir(alphaDir);
    expect(allContent).not.toContain(".openclaw-bravo");
    expect(allContent).not.toContain("18791");
  });

  test("workspace seed files are created", () => {
    ensureProvisioned("alpha", 18790);
    const ws = path.join(tmpDir, ".openclaw-alpha/workspaces/marketing");
    expect(fs.existsSync(path.join(ws, "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "memory/brand-and-audience.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #5: Tool restrictions in generated config
// ---------------------------------------------------------------------------

describe("#5: Tool restrictions enforced", () => {
  test("exec security is deny and fs is workspaceOnly", () => {
    ensureProvisioned("alpha", 18790);
    const config = readConfig("alpha");
    const agent = (
      (config.agents as Record<string, unknown>).list as Array<Record<string, unknown>>
    )[0];
    const tools = agent.tools as Record<string, Record<string, unknown>>;

    expect(tools.exec?.security).toBe("deny");
    expect(tools.fs?.workspaceOnly).toBe(true);
  });

  test("host-bound skills are disabled in config", () => {
    ensureProvisioned("alpha", 18790);
    const config = readConfig("alpha");
    const skills = config.skills as Record<string, Record<string, Record<string, unknown>>>;

    // Fail-closed: skills.entries MUST exist with disabled entries
    expect(skills).toBeDefined();
    expect(skills.entries).toBeDefined();
    expect(skills.entries["things-mac"]?.enabled).toBe(false);
    expect(skills.entries["tmux"]?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #2: Lifecycle isolation — stopping A doesn't affect B
// ---------------------------------------------------------------------------

describe("#2: Lifecycle isolation", () => {
  test("pausing alpha doesn't affect bravo", () => {
    ensureProvisioned("alpha", 18790);
    ensureProvisioned("bravo", 18791);

    let alphaM = readManifest("alpha");
    let bravoM = readManifest("bravo");
    expect(alphaM.status).toBe("active");
    expect(bravoM.status).toBe("active");

    // Re-seed shim state so both show as running
    fs.writeFileSync(path.join(shimStateDir, "alpha.state"), "running");
    fs.writeFileSync(path.join(shimStateDir, "bravo.state"), "running");

    // Pause alpha
    provision("pause alpha");

    alphaM = readManifest("alpha");
    bravoM = readManifest("bravo");
    expect(alphaM.status).toBe("paused");
    expect(bravoM.status).toBe("active");

    // Shim state
    const aState = fs.readFileSync(path.join(shimStateDir, "alpha.state"), "utf8").trim();
    const bState = fs.readFileSync(path.join(shimStateDir, "bravo.state"), "utf8").trim();
    expect(aState).toBe("stopped");
    expect(bState).toBe("running");
  });

  test("customer-status.sh --json shows mixed state correctly", () => {
    ensureProvisioned("alpha", 18790);
    ensureProvisioned("bravo", 18791);

    // Set manifest states to simulate pause scenario
    const alphaManifestPath = path.join(customersDir, "alpha.json");
    const am = JSON.parse(fs.readFileSync(alphaManifestPath, "utf8"));
    am.status = "paused";
    fs.writeFileSync(alphaManifestPath, JSON.stringify(am, null, 2));

    // Seed shim state: alpha stopped, bravo running
    fs.writeFileSync(path.join(shimStateDir, "alpha.state"), "stopped");
    fs.writeFileSync(path.join(shimStateDir, "bravo.state"), "running");

    const output = customerStatus("--json");
    const statuses = JSON.parse(output) as Array<Record<string, unknown>>;

    const alpha = statuses.find((s) => s.customerId === "alpha");
    const bravo = statuses.find((s) => s.customerId === "bravo");

    expect(alpha).toBeDefined();
    expect(bravo).toBeDefined();
    expect(alpha!.status).toBe("paused");
    expect(alpha!.gateway).toBe("stopped");
    expect(bravo!.status).toBe("active");
    expect(bravo!.gateway).toBe("running");
  });

  test("resume alpha restores active state", () => {
    ensureProvisioned("alpha", 18790);

    // Set manifest to paused (simulating prior pause)
    const alphaManifestPath = path.join(customersDir, "alpha.json");
    const am = JSON.parse(fs.readFileSync(alphaManifestPath, "utf8"));
    am.status = "paused";
    fs.writeFileSync(alphaManifestPath, JSON.stringify(am, null, 2));

    // Seed shim state so gateway start + status probe succeed
    fs.writeFileSync(path.join(shimStateDir, "alpha.state"), "installed");

    provision("resume alpha");
    const alphaM = readManifest("alpha");
    expect(alphaM.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// #6: Port and path conflict rejection
// ---------------------------------------------------------------------------

describe("#6: Conflict detection", () => {
  test("rejects duplicate port", () => {
    ensureProvisioned("alpha", 18790);
    createManifest("charlie", { port: 18790 }); // same as alpha
    const output = provision("create charlie --force", { expectFail: true });
    expect(output).toContain("conflicts with");
    expect(fs.existsSync(path.join(tmpDir, ".openclaw-charlie"))).toBe(false);
  });

  test("rejects existing state dir on create", () => {
    ensureProvisioned("alpha", 18790);
    createManifest("alpha", { port: 18795, status: "template" });
    const output = provision("create alpha --force", { expectFail: true });
    expect(output).toContain("already exists");
  });

  test("rejects operator gateway port 18789", () => {
    createManifest("delta", { port: 18789 });
    const output = provision("create delta --force", { expectFail: true });
    expect(output).toContain("conflicts with");
    expect(output).toContain("operator-gateway");
  });
});

// ---------------------------------------------------------------------------
// Template filtering
// ---------------------------------------------------------------------------

describe("Template manifest filtering", () => {
  test("template manifests are skipped by customer-status.sh", () => {
    createManifest("ghost", { port: 18799, status: "template" });
    const output = customerStatus("--json");
    const statuses = JSON.parse(output) as Array<Record<string, unknown>>;
    expect(statuses.find((s) => s.customerId === "ghost")).toBeUndefined();
  });
});
