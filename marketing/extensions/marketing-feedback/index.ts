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

export default {
  id: "marketing-feedback",
  name: "Marketing Feedback Loop",
  description:
    "Records agent skill usage, detects campaign feedback, and injects memory reminders.",

  register(api: OpenClawPluginApi) {
    // --- Record skill effectiveness after each agent run ---
    api.on("agent_end", async (event, ctx) => {
      const agentId = ctx.agentId ?? "";
      if (!TRACKED_AGENT_IDS.has(agentId)) {
        return;
      }

      const ev = event as Record<string, unknown>;
      const toolsUsed = ev.toolsUsed ?? [];
      const stopReason = ev.stopReason ?? "unknown";
      const usage = ev.usage as { totalTokens?: number } | undefined;
      const durationMs = ev.durationMs ?? 0;

      const logEntry = [
        `| ${new Date().toISOString().split("T")[0]}`,
        `| ${agentId}`,
        `| ${Array.isArray(toolsUsed) ? toolsUsed.join(", ") : "none"}`,
        `| ${String(stopReason)}`,
        `| ${usage?.totalTokens ?? 0}`,
        `| ${String(durationMs)}ms |`,
      ].join(" ");

      api.logger.info("feedback", logEntry);
    });

    // --- Detect feedback messages and tag campaigns ---
    api.on("message_received", async (event) => {
      const ev = event as Record<string, unknown>;
      const text = ((ev.text as string | undefined) ?? "").toLowerCase();

      const feedbackKeywords = [
        "worked well",
        "didn't work",
        "great results",
        "poor performance",
        "feedback:",
        "learnings:",
      ];

      if (feedbackKeywords.some((kw) => text.includes(kw))) {
        api.logger.info(
          "feedback",
          `Campaign feedback detected: ${text.slice(0, 200)}`,
        );
      }
    });

    // --- Inject recent lessons before each agent start ---
    api.on("before_agent_start", async (event, ctx) => {
      if (!ORCHESTRATOR_IDS.has(ctx.agentId ?? "")) return;

      const ev = event as Record<string, unknown>;
      const sections = ev.systemPromptSections as
        | Array<{ title: string; content: string }>
        | undefined;

      if (sections) {
        sections.push({
          title: "Reminder",
          content:
            "Before making campaign decisions, always search memory for recent lessons: memory_search('campaign lessons learned')",
        });
      }
    });
  },
};
