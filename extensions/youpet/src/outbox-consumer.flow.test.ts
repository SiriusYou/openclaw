import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
} from "../test/flow-store.fixture.js";
import { createCoreOutboxEvent } from "../test/outbox-consumer.fixture.js";
import {
  createYouPetOutboxConsumerSettingsFromConfig,
  YouPetOutboxConsumer,
  type YouPetOutboxEventEnvelope,
  type YouPetOutboxFetch,
} from "./outbox-consumer.js";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetch(events: YouPetOutboxEventEnvelope[]) {
  const requests: CapturedRequest[] = [];
  const fetchFn: YouPetOutboxFetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });

    if (parsed.pathname === "/internal/events/outbox") {
      return jsonResponse({ items: events });
    }
    if (parsed.pathname.endsWith("/ack")) {
      return jsonResponse({
        event_id: parsed.pathname.split("/").at(-2),
        consumer: "openclaw",
        state: "delivered",
        attempts: 0,
        next_attempt_at: "2026-06-01T00:00:00Z",
      });
    }
    if (parsed.pathname.endsWith("/nack")) {
      return jsonResponse({
        event_id: parsed.pathname.split("/").at(-2),
        consumer: "openclaw",
        state: "pending",
        attempts: 1,
        next_attempt_at: "2026-06-01T00:05:00Z",
      });
    }
    return jsonResponse({ detail: { code: "not_found", message: parsed.pathname } }, 404);
  };
  return { fetchFn, requests };
}

afterEach(async () => {
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPetOutboxConsumer health plan flows", () => {
  it("creates a health plan flow through the production settings path without Core writeback", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        { plan_id: "plan-1", pet_id: "pet-1" },
        {
          aggregate_type: "health_plan",
          aggregate_id: "plan-1",
          correlation_id: "corr-flow",
        },
      ),
    ]);
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
      },
      env: {},
    });
    const consumer = new YouPetOutboxConsumer({
      ...settings,
      fetchFn,
      flowStore,
    });

    const result = await consumer.pollOnce();

    expect(settings.handlers).toBeUndefined();
    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    const flow = flowStore.lookupFlowByPlanId("plan-1");
    expect(flow).toMatchObject({
      plan_id: "plan-1",
      pet_id: "pet-1",
      status: "active",
      correlation_id: "corr-flow",
      created_from_event_id: "evt-health_plan.activated",
      checkin_count: 0,
      last_checkin_at: null,
    });
    expect(flow?.flow_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(flowStore.lookupProcessedEvent("evt-health_plan.activated")).toMatchObject({
      flow_id: flow?.flow_id,
      event_type: "health_plan.activated",
      aggregate_id: "plan-1",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
    expect(requests.some((request) => new URL(request.url).pathname.startsWith("/api/v1/"))).toBe(
      false,
    );
  });

  it("nacks malformed health_plan.activated payloads without creating a flow", async () => {
    const logger = { warn: vi.fn() };
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        { pet_id: "pet-1" },
        {
          event_id: "evt-health-plan-missing-plan",
          aggregate_type: "health_plan",
          aggregate_id: "plan-1",
        },
      ),
    ]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      flowStore,
      logger,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(flows.entries()).toEqual([]);
    expect(processedEvents.entries()).toEqual([]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-health-plan-missing-plan/nack",
    ]);
    expect(requests[1]?.body).toEqual({
      error: "Malformed YouPet health_plan.activated payload",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Malformed health_plan.activated event evt-health-plan-missing-plan: missing plan_id",
    );
  });

  it("acknowledges health_plan.activated without flow creation when manageFlows is disabled", async () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        { plan_id: "plan-1", pet_id: "pet-1" },
        {
          aggregate_type: "health_plan",
          aggregate_id: "plan-1",
        },
      ),
    ]);
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        manageFlows: false,
      },
      env: {},
    });
    const consumer = new YouPetOutboxConsumer({
      ...settings,
      fetchFn,
      flowStore,
    });

    const result = await consumer.pollOnce();

    expect(settings.manageFlows).toBe(false);
    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(flows.entries()).toEqual([]);
    expect(processedEvents.entries()).toEqual([]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
  });

  it("nacks health_plan.activated events missing the nested business payload without writing a flow", async () => {
    const logger = { warn: vi.fn() };
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        {},
        {
          event_id: "evt-health-plan-missing-payload",
          aggregate_type: "health_plan",
          aggregate_id: "plan-1",
          // Core nests business fields under payload.payload; an envelope whose
          // payload object lacks the nested payload must nack, not silently drop.
          payload: { event_type: "health_plan.activated" },
        },
      ),
    ]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      flowStore,
      logger,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(flows.entries()).toEqual([]);
    expect(processedEvents.entries()).toEqual([]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-health-plan-missing-payload/nack",
    ]);
    expect(requests[1]?.body).toEqual({
      error: "Malformed YouPet health_plan.activated payload",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Malformed health_plan.activated event evt-health-plan-missing-payload: missing payload.payload",
    );
  });
});
