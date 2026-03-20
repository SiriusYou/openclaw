import fs from "node:fs";
import path from "node:path";
import { describe, test, expect } from "vitest";
import { loadManifests } from "./test-helpers.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CUSTOMERS_DIR = path.join(REPO_ROOT, "marketing/customers");
const SKILLS_DIR = path.join(REPO_ROOT, "marketing/workspaces/marketing/skills/core-marketing");

/** Required fields for all non-template manifests. */
const REQUIRED_FIELDS = [
  "customerId",
  "status",
  "port",
  "channels",
  "brandName",
  "audience",
  "modelProfile",
  "skills",
  "sandbox",
  "tools",
];

// ---------------------------------------------------------------------------
// Basic manifest validity
// ---------------------------------------------------------------------------

describe("Manifest JSON validity", () => {
  const files = fs.readdirSync(CUSTOMERS_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    test(`${file} parses as valid JSON`, () => {
      const raw = fs.readFileSync(path.join(CUSTOMERS_DIR, file), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  }
});

describe("Manifest required fields", () => {
  const manifests = loadManifests(CUSTOMERS_DIR);

  test("example.json has all required fields", () => {
    const example = manifests.find((m) => m.name === "example");
    expect(example, "example.json not found").toBeDefined();

    for (const field of REQUIRED_FIELDS) {
      expect(example!.data[field], `example.json missing required field: ${field}`).toBeDefined();
    }
  });

  for (const manifest of manifests) {
    if (manifest.data.status === "template") {
      continue;
    }

    test(`${manifest.name}.json has all required fields`, () => {
      for (const field of REQUIRED_FIELDS) {
        expect(
          manifest.data[field],
          `${manifest.name}: missing required field: ${field}`,
        ).toBeDefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Uniqueness constraints
// ---------------------------------------------------------------------------

describe("Uniqueness constraints", () => {
  const manifests = loadManifests(CUSTOMERS_DIR).filter((m) => m.data.status !== "template");

  test("all non-template manifests have unique ports", () => {
    const seen = new Map<number, string>();

    for (const m of manifests) {
      const port = m.data.port as number;
      if (seen.has(port)) {
        expect.fail(`Port ${port} used by both '${seen.get(port)}' and '${m.name}'`);
      }
      seen.set(port, m.name);
    }
  });

  test("all non-template manifests have valid customerId format", () => {
    for (const m of manifests) {
      const id = m.data.customerId as string;
      expect(id, `${m.name}: customerId is empty`).toBeTruthy();
      expect(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id),
        `${m.name}: customerId '${id}' has invalid characters`,
      ).toBe(true);
    }
  });

  test("customerId matches filename for all manifests", () => {
    for (const m of manifests) {
      expect(
        m.data.customerId,
        `${m.name}: customerId '${String(m.data.customerId)}' does not match filename`,
      ).toBe(m.name);
    }
  });
});

// ---------------------------------------------------------------------------
// Reporting config fail-closed validation
// ---------------------------------------------------------------------------

describe("Reporting config validation", () => {
  const manifests = loadManifests(CUSTOMERS_DIR);

  for (const manifest of manifests) {
    const reporting = manifest.data.reporting as Record<string, unknown> | undefined;
    if (!reporting) {
      continue;
    }

    test(`${manifest.name}: reporting.delivery.target is present if reporting configured`, () => {
      const delivery = reporting.delivery as Record<string, string> | undefined;

      // For template manifests, empty target is acceptable (it's a placeholder)
      if (manifest.data.status === "template") {
        return;
      }

      expect(delivery, `${manifest.name}: reporting.delivery is missing`).toBeDefined();
      expect(
        delivery!.target,
        `${manifest.name}: reporting.delivery.target is empty (fail-closed: crons will not be created)`,
      ).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Skills array references only existing skill directories
// ---------------------------------------------------------------------------

describe("Skill references", () => {
  const manifests = loadManifests(CUSTOMERS_DIR);

  for (const manifest of manifests) {
    test(`${manifest.name}: skills array references existing skill dirs`, () => {
      const skills = (manifest.data.skills || []) as string[];

      const missing = skills.filter((s) => !fs.existsSync(path.join(SKILLS_DIR, s, "SKILL.md")));
      expect(
        missing,
        `${manifest.name}: references non-existent skills: ${missing.join(", ")}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Workspace template seeding (provision-customer.sh creates these)
// ---------------------------------------------------------------------------

describe("Provision workspace templates", () => {
  test("provision-customer.sh seeds status/ and memory/ templates", () => {
    // This test validates that the provision script WOULD create the right files.
    // We check by reading the script source for the template heredocs.
    const scriptPath = path.join(REPO_ROOT, "marketing/scripts/provision-customer.sh");
    const script = fs.readFileSync(scriptPath, "utf8");

    expect(script).toContain("status/weekly-status.md");
    expect(script).toContain("status/monthly-status.md");
    expect(script).toContain("memory/campaign-lessons-learned.md");
    expect(script).toContain("HEARTBEAT.md");
  });
});
