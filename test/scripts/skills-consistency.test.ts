import fs from "node:fs";
import path from "node:path";
import { describe, test, expect } from "vitest";
import { loadManifests, parseFrontmatter } from "./test-helpers.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SKILLS_DIR = path.join(REPO_ROOT, "marketing/workspaces/marketing/skills/core-marketing");
const CUSTOMERS_DIR = path.join(REPO_ROOT, "marketing/customers");
const LIFECYCLE_SKILL = path.join(SKILLS_DIR, "campaign-lifecycle/SKILL.md");

/**
 * All expected core marketing skills. This list must match the skills distributed
 * to customer workspaces by provision-customer.sh.
 */
const EXPECTED_SKILLS = [
  "campaign-brief",
  "campaign-lifecycle",
  "campaign-diagnosis",
  "structured-brainstorm",
  "content-ab-test",
  "content-repurposing",
  "campaign-decision-gate",
  "weekly-summary",
  "campaign-retrospective",
];

/** Extract skill names referenced by campaign-lifecycle SKILL.md via **Skill**: patterns. */
function extractLifecycleSkillRefs(): string[] {
  const content = fs.readFileSync(LIFECYCLE_SKILL, "utf8");
  const refs: string[] = [];

  // Match patterns like: **Skill**: `campaign-brief`
  // and: **Skills**: `weekly-summary` + `campaign-diagnosis`
  const skillLinePattern = /\*\*Skills?\*\*:\s*(.+)/g;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = skillLinePattern.exec(content)) !== null) {
    const line = lineMatch[1];
    const backtickPattern = /`([a-z][a-z0-9-]+)`/g;
    let bt: RegExpExecArray | null;
    while ((bt = backtickPattern.exec(line)) !== null) {
      refs.push(bt[1]);
    }
  }

  return [...new Set(refs)];
}

// ---------------------------------------------------------------------------
// Skill existence and frontmatter
// ---------------------------------------------------------------------------

describe("Skill files existence", () => {
  for (const skill of EXPECTED_SKILLS) {
    test(`${skill}/SKILL.md exists`, () => {
      const p = path.join(SKILLS_DIR, skill, "SKILL.md");
      expect(fs.existsSync(p), `Missing: ${skill}/SKILL.md`).toBe(true);
    });
  }
});

describe("Skill YAML frontmatter", () => {
  for (const skill of EXPECTED_SKILLS) {
    test(`${skill} has valid frontmatter with name and description`, () => {
      const p = path.join(SKILLS_DIR, skill, "SKILL.md");
      if (!fs.existsSync(p)) {
        return;
      } // skip if file missing (caught above)

      const content = fs.readFileSync(p, "utf8");
      const fm = parseFrontmatter(content);

      expect(fm, `${skill}: missing or invalid YAML frontmatter`).not.toBeNull();
      expect(fm!.name, `${skill}: frontmatter name mismatch`).toBe(skill);
      expect(fm!.description.length, `${skill}: description too short`).toBeGreaterThan(10);
    });
  }
});

// ---------------------------------------------------------------------------
// campaign-lifecycle references only existing skills
// ---------------------------------------------------------------------------

describe("campaign-lifecycle skill references", () => {
  test("all referenced skills exist on disk", () => {
    const refs = extractLifecycleSkillRefs();
    expect(refs.length).toBeGreaterThan(0);

    const missing = refs.filter((r) => !fs.existsSync(path.join(SKILLS_DIR, r, "SKILL.md")));
    expect(
      missing,
      `campaign-lifecycle references non-existent skills: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Customer manifest skills match available skill directories
// ---------------------------------------------------------------------------

describe("Customer manifest skill consistency", () => {
  const manifests = loadManifests(CUSTOMERS_DIR);

  for (const manifest of manifests) {
    test(`${manifest.name}.json skills all exist on disk`, () => {
      const skills: string[] = (manifest.data.skills || []) as string[];

      const missing = skills.filter((s) => !fs.existsSync(path.join(SKILLS_DIR, s, "SKILL.md")));
      expect(
        missing,
        `${manifest.name}: references non-existent skills: ${missing.join(", ")}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// No orphan skills (exist on disk but not in any manifest)
// ---------------------------------------------------------------------------

describe("No orphan skills", () => {
  test("all skills on disk are referenced by at least one manifest", () => {
    const onDisk = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, "SKILL.md")))
      .map((d) => d.name);

    const allManifestSkills = new Set<string>();
    for (const m of loadManifests(CUSTOMERS_DIR)) {
      for (const s of (m.data.skills || []) as string[]) {
        allManifestSkills.add(s);
      }
    }

    // Operator-only skills are intentionally excluded from customer manifests
    // (they require exec tools that customer gateways deny)
    const operatorOnlySkills = new Set(["aitoearn-publish"]);

    const orphans = onDisk.filter((s) => !allManifestSkills.has(s) && !operatorOnlySkills.has(s));
    expect(orphans, `Skills exist on disk but not in any manifest: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });
});
