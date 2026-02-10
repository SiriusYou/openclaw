import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default {
  id: "marketing-feedback",
  name: "Marketing Feedback Loop",
  description:
    "Records agent skill usage, detects campaign feedback, and injects memory reminders.",

  register(api: OpenClawPluginApi) {
    // --- Record skill effectiveness after each agent run ---
    api.on("agent_end", async (event, ctx) => {
      const agentId = ctx.agentId ?? "";
      if (
        !agentId.startsWith("marketing") &&
        agentId !== "content-writer" &&
        agentId !== "analyst"
      ) {
        return;
      }

      const toolsUsed =
        (event as Record<string, unknown>).toolsUsed ?? [];
      const stopReason =
        (event as Record<string, unknown>).stopReason ?? "unknown";
      const usage = (event as Record<string, unknown>).usage as
        | { totalTokens?: number }
        | undefined;
      const durationMs =
        (event as Record<string, unknown>).durationMs ?? 0;

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
      const text =
        ((event as Record<string, unknown>).text as string | undefined)
          ?.toLowerCase() ?? "";

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
      if (ctx.agentId !== "marketing-orchestrator") return;

      const sections = (
        event as Record<string, unknown>
      ).systemPromptSections as
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
