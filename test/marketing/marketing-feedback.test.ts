import { describe, test, expect, vi, beforeEach } from "vitest";
import plugin from "../../marketing/extensions/marketing-feedback/index.js";

function createMockApi() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler;
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    trigger: (event: string, payload: unknown, ctx?: unknown) => handlers[event]?.(payload, ctx),
  };
}

describe("marketing-feedback plugin", () => {
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    api = createMockApi();
    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);
  });

  test("has correct plugin metadata", () => {
    expect(plugin.id).toBe("marketing-feedback");
    expect(plugin.name).toBe("Marketing Feedback Loop");
  });

  test("registers all three event handlers", () => {
    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("message_received", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  // --- agent_end: tracking scope ---

  test("logs tracked agent run (main)", () => {
    api.trigger("agent_end", { success: true, durationMs: 1500 }, { agentId: "main" });
    expect(api.logger.info).toHaveBeenCalledWith("feedback", expect.stringContaining("main"));
    expect(api.logger.info).toHaveBeenCalledWith("feedback", expect.stringContaining("success"));
  });

  test("logs tracked agent run (content-writer)", () => {
    api.trigger("agent_end", { success: true, durationMs: 800 }, { agentId: "content-writer" });
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("content-writer"),
    );
  });

  test("logs tracked agent run (analyst)", () => {
    api.trigger("agent_end", { success: false, error: "timeout" }, { agentId: "analyst" });
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("failed: timeout"),
    );
  });

  test("ignores non-tracked agent", () => {
    api.trigger("agent_end", { success: true, durationMs: 100 }, { agentId: "random-agent" });
    expect(api.logger.info).not.toHaveBeenCalled();
  });

  test("tracks legacy orchestrator ID", () => {
    api.trigger(
      "agent_end",
      { success: true, durationMs: 500 },
      { agentId: "marketing-orchestrator" },
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("marketing-orchestrator"),
    );
  });

  // --- message_received: keyword detection ---

  test("detects 'worked well' feedback keyword", () => {
    api.trigger("message_received", {
      content: "The campaign worked well and drove signups",
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("Campaign feedback detected"),
    );
  });

  test("detects 'poor performance' keyword", () => {
    api.trigger("message_received", {
      content: "Poor performance on the latest ad set",
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("Campaign feedback detected"),
    );
  });

  test("detects 'feedback:' keyword", () => {
    api.trigger("message_received", {
      content: "feedback: the blog post got great engagement",
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("Campaign feedback detected"),
    );
  });

  test("ignores message without feedback keywords", () => {
    api.trigger("message_received", {
      content: "Please create a new campaign brief for Q2",
    });
    expect(api.logger.info).not.toHaveBeenCalled();
  });

  test("keyword matching is case-insensitive", () => {
    api.trigger("message_received", {
      content: "GREAT RESULTS from the email campaign",
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      "feedback",
      expect.stringContaining("Campaign feedback detected"),
    );
  });

  // --- before_agent_start: orchestrator-only injection ---

  test("injects context for orchestrator (main)", () => {
    const result = api.trigger("before_agent_start", {}, { agentId: "main" });
    expect(result).toEqual({
      prependContext: expect.stringContaining("memory_search"),
    });
  });

  test("injects context for legacy orchestrator ID", () => {
    const result = api.trigger("before_agent_start", {}, { agentId: "marketing-orchestrator" });
    expect(result).toEqual({
      prependContext: expect.stringContaining("campaign lessons learned"),
    });
  });

  test("does not inject context for non-orchestrator agents", () => {
    const result = api.trigger("before_agent_start", {}, { agentId: "content-writer" });
    expect(result).toBeUndefined();
  });

  test("does not inject context for analyst", () => {
    const result = api.trigger("before_agent_start", {}, { agentId: "analyst" });
    expect(result).toBeUndefined();
  });
});
