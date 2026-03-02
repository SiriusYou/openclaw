import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const DANGEROUS_PATTERNS = [
  /exec\s*\(/,
  /child_process/,
  /curl.*\|\s*(?:ba)?sh/,
  /eval\s*\(/,
  /rm\s+-rf/,
  /\.env\b/,
  /credentials/,
  /process\.env/,
  /require\s*\(\s*['"](?:fs|net|http|child_process)['"]\s*\)/,
];

// apply_patch header patterns (see apply-patch.ts:15-18)
const PATCH_PATH_PATTERNS = [
  /^\*\*\* Add File: (.+)$/,
  /^\*\*\* Delete File: (.+)$/,
  /^\*\*\* Update File: (.+)$/,
  /^\*\*\* Move to: (.+)$/,
];

function extractPatchPaths(input: string): string[] {
  const paths: string[] = [];
  for (const line of input.split("\n")) {
    for (const pattern of PATCH_PATH_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        paths.push(match[1].trim());
      }
    }
  }
  return paths;
}

/**
 * Coerce a parameter value to a scannable string.
 * before_tool_call fires pre-normalization (pi-tools.read.ts:542),
 * so params may be structured blocks rather than strings.
 */
function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function findDangerousPattern(content: string): RegExp | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Resolve the target file path from write/edit tool params.
 * Checks both normalized and pre-normalization field names.
 */
function resolvePathParam(params: Record<string, unknown>): string {
  return (params.path as string) ?? (params.file_path as string) ?? "";
}

export default {
  id: "skill-audit",
  name: "Skill Audit Gate",
  description:
    "Security gate that validates agent-evolved skills for dangerous patterns before they are written.",

  register(api: OpenClawPluginApi) {
    api.on("before_tool_call", (event) => {
      const { toolName, params } = event;

      let paths: string[] = [];
      let content = "";

      if (toolName === "write" || toolName === "file_write") {
        const path = resolvePathParam(params);
        if (path) paths = [path];
        content = coerceToString(params.content);
      } else if (toolName === "edit" || toolName === "file_edit") {
        const path = resolvePathParam(params);
        if (path) paths = [path];
        // Check both field names: newText (post-normalization) and new_string (pre-normalization)
        content = coerceToString(params.newText || params.new_string);
      } else if (toolName === "apply_patch") {
        const input = coerceToString(params.input);
        paths = extractPatchPaths(input);
        content = input;
      } else {
        return;
      }

      const hasEvolvedPath = paths.some((p) => p.includes("skills/evolved/"));
      if (!hasEvolvedPath) {
        // Unresolvable apply_patch paths are blocked as a safety fallback
        if (toolName === "apply_patch" && paths.length === 0 && content.length > 0) {
          api.logger.warn(
            "skill-audit",
            "BLOCKED: Could not extract paths from apply_patch — blocking as safety fallback",
          );
          return {
            block: true,
            blockReason: "Could not determine target paths from patch content. Blocking as safety precaution.",
          };
        }
        return;
      }

      const dangerousPattern = findDangerousPattern(content);
      const pathList = paths.join(", ");

      if (dangerousPattern) {
        api.logger.warn(
          "skill-audit",
          `BLOCKED: Evolved skill write to ${pathList} contains dangerous pattern: ${dangerousPattern.source}`,
        );
        return {
          block: true,
          blockReason: `Skill audit blocked: content contains dangerous pattern "${dangerousPattern.source}" targeting evolved skill path(s): ${pathList}`,
        };
      }

      api.logger.info("skill-audit", `Approved evolved skill write: ${pathList}`);
    });
  },
};
