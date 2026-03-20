import fs from "node:fs";
import path from "node:path";

export interface ManifestFile {
  name: string;
  path: string;
  data: Record<string, unknown>;
}

/** Load all customer manifest JSON files from a directory. */
export function loadManifests(customersDir: string): ManifestFile[] {
  return fs
    .readdirSync(customersDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f.replace(".json", ""),
      path: path.join(customersDir, f),
      data: JSON.parse(fs.readFileSync(path.join(customersDir, f), "utf8")),
    }));
}

/** Parse YAML frontmatter from a SKILL.md file. Returns { name, description } or null. */
export function parseFrontmatter(content: string): { name: string; description: string } | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return null;
  }

  const yaml = fmMatch[1];
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const descMatch = yaml.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descMatch) {
    return null;
  }
  return { name: nameMatch[1].trim(), description: descMatch[1].trim() };
}
