import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test, expect } from "vitest";

const KIT_DIR = resolve(__dirname, "../../marketing/marketclaw-kit");

describe("MarketClaw Kit — Package Integrity", () => {
  test("kit directory exists", () => {
    expect(existsSync(KIT_DIR)).toBe(true);
  });

  test("pre-package-scan detects zero secrets", () => {
    const scanScript = resolve(__dirname, "../../marketing/scripts/pre-package-scan.sh");
    const result = execFileSync("bash", [scanScript, KIT_DIR], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result).toContain("No secrets detected");
  });

  test("no .env files present (only .env.example)", () => {
    const envFiles = findFiles(KIT_DIR, (name) => /^\.env($|\.local$|\.production$)/.test(name));
    expect(envFiles).toEqual([]);
  });

  describe("required top-level files", () => {
    const requiredFiles = ["README.md", "setup.sh", ".env.example", ".gitignore", "openclaw.json"];

    for (const file of requiredFiles) {
      test(`${file} exists`, () => {
        expect(existsSync(join(KIT_DIR, file))).toBe(true);
      });
    }
  });

  describe("scripts directory", () => {
    const requiredScripts = [
      "provision-customer.sh",
      "customer-status.sh",
      "configure-customer-crons.sh",
      "pre-package-scan.sh",
      "daily-backup.sh",
      "log-rotate.sh",
      "upgrade-cli.sh",
      "cron-health-check.sh",
      "health-check.sh",
    ];

    for (const script of requiredScripts) {
      test(`scripts/${script} exists`, () => {
        expect(existsSync(join(KIT_DIR, "scripts", script))).toBe(true);
      });
    }

    test("scripts are executable", () => {
      for (const script of requiredScripts) {
        const path = join(KIT_DIR, "scripts", script);
        const stat = statSync(path);
        expect(stat.mode & 0o100).toBeGreaterThan(0);
      }
    });
  });

  describe("12 core marketing skills", () => {
    const requiredSkills = [
      "campaign-brief",
      "campaign-decision-gate",
      "campaign-diagnosis",
      "campaign-lifecycle",
      "campaign-retrospective",
      "content-ab-test",
      "content-repurposing",
      "structured-brainstorm",
      "weekly-summary",
    ];

    const skillsDir = join(KIT_DIR, "workspaces/marketing/skills/core-marketing");

    for (const skill of requiredSkills) {
      test(`${skill}/SKILL.md exists`, () => {
        expect(existsSync(join(skillsDir, skill, "SKILL.md"))).toBe(true);
      });
    }

    test("exactly 12 skill directories", () => {
      const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
      expect(dirs.length).toBe(12);
    });
  });

  describe("workspace template files", () => {
    const workspaceFiles = [
      "workspaces/marketing/AGENTS.md",
      "workspaces/marketing/SOUL.md",
      "workspaces/marketing/HEARTBEAT.md",
      "workspaces/marketing/MEMORY.md",
    ];

    for (const file of workspaceFiles) {
      test(`${file} exists`, () => {
        expect(existsSync(join(KIT_DIR, file))).toBe(true);
      });
    }
  });

  describe("knowledge base templates", () => {
    const templates = [
      "memory/brand-and-audience.md",
      "memory/campaign-lessons-learned.md",
      "memory/content-topics.md",
      "strategies/campaign-playbook.md",
      "performance/baseline-metrics.md",
      "content/memory/content-style-guide.md",
      "analytics/memory/market-research.md",
    ];

    for (const file of templates) {
      test(`${file} exists`, () => {
        expect(existsSync(join(KIT_DIR, file))).toBe(true);
      });
    }
  });

  describe("extensions", () => {
    for (const ext of ["marketing-feedback", "skill-audit"]) {
      test(`${ext} extension has package.json`, () => {
        expect(existsSync(join(KIT_DIR, "extensions", ext, "package.json"))).toBe(true);
      });

      test(`${ext} extension has plugin manifest`, () => {
        expect(existsSync(join(KIT_DIR, "extensions", ext, "openclaw.plugin.json"))).toBe(true);
      });
    }
  });

  describe("docs", () => {
    for (const doc of ["quick-start.md", "client-onboarding.md", "architecture.md"]) {
      test(`docs/${doc} exists`, () => {
        expect(existsSync(join(KIT_DIR, "docs", doc))).toBe(true);
      });
    }
  });

  describe("openclaw.json config", () => {
    test("uses __WORKSPACE_ROOT__ placeholder", () => {
      const config = readFileSync(join(KIT_DIR, "openclaw.json"), "utf8");
      expect(config).toContain("__WORKSPACE_ROOT__");
    });

    test("has 5 agents (main + 4 sub-agents)", () => {
      const config = JSON.parse(readFileSync(join(KIT_DIR, "openclaw.json"), "utf8"));
      const agentIds = config.agents.list.map((a: { id: string }) => a.id);
      expect(agentIds).toEqual(["main", "content-writer", "analyst", "video-maker", "image-maker"]);
    });

    test("does not include clawhub skill", () => {
      const config = JSON.parse(readFileSync(join(KIT_DIR, "openclaw.json"), "utf8"));
      const mainAgent = config.agents.list[0];
      expect(mainAgent.skills).not.toContain("clawhub");
    });

    test("lists exactly 9 skills", () => {
      const config = JSON.parse(readFileSync(join(KIT_DIR, "openclaw.json"), "utf8"));
      const mainAgent = config.agents.list[0];
      expect(mainAgent.skills.length).toBe(9);
    });

    test("primary model matches source config", () => {
      const config = JSON.parse(readFileSync(join(KIT_DIR, "openclaw.json"), "utf8"));
      const mainAgent = config.agents.list[0];
      expect(mainAgent.model.primary).toBe("minimax/MiniMax-M2.7-highspeed");
      expect(mainAgent.model.fallbacks).toEqual([
        "openai-codex/gpt-5.4",
        "google/gemini-3.1-pro-preview",
      ]);
    });

    test("sandbox mode is off", () => {
      const config = JSON.parse(readFileSync(join(KIT_DIR, "openclaw.json"), "utf8"));
      expect(config.agents.defaults.sandbox.mode).toBe("off");
      const mainAgent = config.agents.list[0];
      expect(mainAgent.sandbox.mode).toBe("off");
    });
  });

  describe("template files contain placeholders, not real data", () => {
    test("brand-and-audience uses placeholders", () => {
      const content = readFileSync(join(KIT_DIR, "memory/brand-and-audience.md"), "utf8");
      expect(content).toContain("YOUR_BRAND_NAME");
      expect(content).not.toContain("Test Alpha");
    });

    test("content-topics uses placeholders", () => {
      const content = readFileSync(join(KIT_DIR, "memory/content-topics.md"), "utf8");
      expect(content).toContain("TOPIC_1_TITLE");
    });

    test("campaign-lessons-learned is empty template", () => {
      const content = readFileSync(join(KIT_DIR, "memory/campaign-lessons-learned.md"), "utf8");
      expect(content).not.toContain("R4");
      expect(content).not.toContain("R5");
      expect(content).not.toContain("2026-03");
    });

    test("baseline-metrics uses placeholders", () => {
      const content = readFileSync(join(KIT_DIR, "performance/baseline-metrics.md"), "utf8");
      expect(content).toContain("YOUR_BUDGET");
      expect(content).not.toContain("1,200");
    });
  });

  describe("customer manifest", () => {
    test("example.json has 9 skills", () => {
      const manifest = JSON.parse(readFileSync(join(KIT_DIR, "customers/example.json"), "utf8"));
      expect(manifest.skills.length).toBe(9);
    });

    test("example.json status is template", () => {
      const manifest = JSON.parse(readFileSync(join(KIT_DIR, "customers/example.json"), "utf8"));
      expect(manifest.status).toBe("template");
    });

    test("example.json modelProfile matches source config", () => {
      const manifest = JSON.parse(readFileSync(join(KIT_DIR, "customers/example.json"), "utf8"));
      expect(manifest.modelProfile.primary).toBe("google/gemini-3-pro-preview");
      expect(manifest.modelProfile.fallbacks).toEqual(["openrouter/auto"]);
    });
  });
});

/** Recursively find files matching a predicate */
function findFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, predicate));
    } else if (predicate(entry.name)) {
      results.push(full);
    }
  }
  return results;
}
