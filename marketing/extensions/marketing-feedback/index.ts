import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Canonical orchestrator ID is "main"; keep legacy alias for backward compat
const ORCHESTRATOR_IDS: ReadonlySet<string> = new Set([
  "main",
  "marketing-orchestrator",
]);

// Fixed set (not prefix match) to prevent ID drift; add new marketing agents here
const TRACKED_AGENT_IDS: ReadonlySet<string> = new Set([
  ...ORCHESTRATOR_IDS,
  "content-writer",
  "analyst",
]);

const FEEDBACK_KEYWORDS = [
  "worked well",
  "didn't work",
  "great results",
  "poor performance",
  "feedback:",
  "learnings:",
];

export default {
  id: "marketing-feedback",
  name: "Marketing Feedback Loop",
  description:
    "Records agent skill usage, detects campaign feedback, and injects memory reminders.",

  register(api: OpenClawPluginApi) {
    // Record agent run outcome (fire-and-forget)
    api.on("agent_end", (event, ctx) => {
      const agentId = ctx.agentId ?? "";
      if (!TRACKED_AGENT_IDS.has(agentId)) return;

      const status = event.success
        ? "success"
        : `failed: ${event.error ?? "unknown"}`;

      api.logger.info(
        "feedback",
        `| ${new Date().toISOString().split("T")[0]} | ${agentId} | ${status} | ${event.durationMs ?? 0}ms |`,
      );
    });

    // Detect feedback messages and tag campaigns
    api.on("message_received", (event) => {
      const content = event.content.toLowerCase();

      if (FEEDBACK_KEYWORDS.some((kw) => content.includes(kw))) {
        api.logger.info(
          "feedback",
          `Campaign feedback detected: ${content.slice(0, 200)}`,
        );
      }
    });

    // Inject recent lessons before orchestrator starts (modifying hook)
    api.on("before_agent_start", (_event, ctx) => {
      if (!ORCHESTRATOR_IDS.has(ctx.agentId ?? "")) return;

      return {
        prependContext:
          "Before making campaign decisions, always search memory for recent lessons: memory_search('campaign lessons learned')",
      };
    });
  },
};
