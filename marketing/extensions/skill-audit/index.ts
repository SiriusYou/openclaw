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

export default {
  id: "skill-audit",
  name: "Skill Audit Gate",
  description:
    "Security gate that validates agent-evolved skills for dangerous patterns before they are loaded.",

  register(api: OpenClawPluginApi) {
    api.on("after_tool_call", async (event) => {
      const input = (event as Record<string, unknown>).input as
        | Record<string, unknown>
        | undefined;
      const path =
        (input?.path as string) ?? (input?.file_path as string) ?? "";

      // Only audit files written to the evolved skills directory
      if (!path.includes("skills/evolved/")) return;

      const content =
        typeof (event as Record<string, unknown>).result === "string"
          ? ((event as Record<string, unknown>).result as string)
          : "";

      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(content)) {
          api.logger.warn(
            "skill-audit",
            `BLOCKED: Evolved skill at ${path} contains dangerous pattern: ${pattern.source}`,
          );
          return;
        }
      }

      api.logger.info("skill-audit", `Approved evolved skill: ${path}`);
    });
  },
};
