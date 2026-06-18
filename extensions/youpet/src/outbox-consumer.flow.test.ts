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
  headers: Record<string, string>;
  body: unknown;
};

type FlowResponse =
  | {
      status?: number;
      body?: unknown;
      text?: string;
    }
  | {
      error: Error;
    };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetch(events: YouPetOutboxEventEnvelope[], flowResponses: FlowResponse[] = []) {
  const requests: CapturedRequest[] = [];
  const fetchFn: YouPetOutboxFetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, headers, body });

    if (parsed.pathname === "/internal/events/outbox") {
      return jsonResponse({ items: events });
    }
    if (parsed.pathname.match(/^\/api\/v1\/health-plans\/[^/]+\/flow$/)) {
      const next = flowResponses.shift() ?? { body: { openclaw_flow_id: body?.openclaw_flow_id } };
      if ("error" in next) {
        throw next.error;
      }
      if (next.text !== undefined) {
        return new Response(next.text, { status: next.status ?? 500 });
      }
      return jsonResponse(next.body ?? {}, next.status ?? 200);
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

function pathnames(requests: CapturedRequest[]): string[] {
  return requests.map((request) => new URL(request.url).pathname);
}

function flowRequests(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter((request) =>
    new URL(request.url).pathname.match(/^\/api\/v1\/health-plans\/[^/]+\/flow$/),
  );
}

function createCheckinEvent(
  businessPayload: Record<string, unknown> = {},
  overrides: Partial<YouPetOutboxEventEnvelope> = {},
): YouPetOutboxEventEnvelope {
  const checkinId =
    typeof businessPayload.checkin_id === "string" ? businessPayload.checkin_id : "checkin-1";
  return createCoreOutboxEvent(
    "task.checkin_received",
    {
      task_id: "task-1",
      checkin_id: checkinId,
      plan_id: "plan-1",
      pet_id: "pet-1",
      ...businessPayload,
    },
    {
      aggregate_type: "checkin",
      aggregate_id: checkinId,
      ...overrides,
    },
  );
}

afterEach(async () => {
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPetOutboxConsumer health plan flows", () => {
  it("writes a newly-created health plan flow back through the production settings path", async () => {
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
      core_linked: true,
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
    const flowWriteback = flowRequests(requests);
    expect(flowWriteback).toHaveLength(1);
    expect(flowWriteback[0]).toMatchObject({
      method: "POST",
      body: { openclaw_flow_id: flow?.flow_id },
    });
    expect(flowWriteback[0]?.headers["idempotency-key"]).toBe(
      "openclaw:youpet:evt-health_plan.activated:flow-link",
    );
    expect(flowWriteback[0]?.headers["x-correlation-id"]).toBe("corr-flow");
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/health-plans/plan-1/flow",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
  });

  it("does not write back again after the flow is linked", async () => {
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
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      flowStore,
    });

    await consumer.pollOnce();
    const second = await consumer.pollOnce();

    expect(second).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(flowStore.lookupFlowByPlanId("plan-1")?.core_linked).toBe(true);
    expect(flowRequests(requests)).toHaveLength(1);
  });

  it("advances task check-ins through the production settings path", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-flow",
    });
    const { fetchFn, requests } = createFetch([createCheckinEvent()]);
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
      checkin_count: 1,
    });
    expect(flow?.last_checkin_at).toEqual(expect.any(String));
    expect(flowStore.lookupProcessedEvent("evt-task.checkin_received")).toMatchObject({
      flow_id: flow?.flow_id,
      event_type: "task.checkin_received",
      aggregate_id: "checkin-1",
    });
    expect(flowRequests(requests)).toHaveLength(0);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
    ]);
  });

  it("does not double-count redelivered task check-in events", async () => {
    const { flowStore, processedEvents } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-flow",
    });
    const { fetchFn, requests } = createFetch([createCheckinEvent()]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      flowStore,
    });

    const first = await consumer.pollOnce();
    const second = await consumer.pollOnce();

    expect(first).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(second).toEqual(first);
    expect(flowStore.lookupFlowByPlanId("plan-1")?.checkin_count).toBe(1);
    expect(
      processedEvents
        .entries()
        .filter((entry) => entry.value.event_id === "evt-task.checkin_received"),
    ).toHaveLength(1);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
    ]);
  });

  it("lazy-creates an unlinked flow from an out-of-order check-in and links it on activation", async () => {
    const { flowStore, flows } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const checkinFetch = createFetch([
      createCheckinEvent(
        {},
        {
          correlation_id: "corr-checkin",
        },
      ),
    ]);
    const checkinConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn: checkinFetch.fetchFn,
      flowStore,
    });

    const checkinResult = await checkinConsumer.pollOnce();
    const created = flowStore.lookupFlowByPlanId("plan-1");

    expect(checkinResult).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(created).toMatchObject({
      plan_id: "plan-1",
      pet_id: "pet-1",
      core_linked: false,
      correlation_id: "corr-checkin",
      created_from_event_id: "evt-task.checkin_received",
      checkin_count: 1,
    });
    expect(flowRequests(checkinFetch.requests)).toHaveLength(0);

    const activationFetch = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        { plan_id: "plan-1", pet_id: "pet-1" },
        {
          aggregate_type: "health_plan",
          aggregate_id: "plan-1",
          correlation_id: "corr-activation",
        },
      ),
    ]);
    const activationConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn: activationFetch.fetchFn,
      flowStore,
    });

    const activationResult = await activationConsumer.pollOnce();
    const linked = flowStore.lookupFlowByPlanId("plan-1");

    expect(activationResult).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(linked).toMatchObject({
      flow_id: created?.flow_id,
      core_linked: true,
      checkin_count: 1,
      correlation_id: "corr-checkin",
    });
    expect(flows.entries()).toHaveLength(1);
    expect(flowRequests(activationFetch.requests)).toHaveLength(1);
    expect(pathnames(activationFetch.requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/health-plans/plan-1/flow",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
  });

  it("acknowledges task check-ins without flow changes when manageFlows is disabled", async () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([createCheckinEvent()]);
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
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
    ]);
  });

  for (const scenario of [
    {
      name: "missing plan_id",
      event: createCheckinEvent(
        { plan_id: null },
        {
          event_id: "evt-checkin-missing-plan",
        },
      ),
      warning:
        "[youpet] Malformed task.checkin_received event evt-checkin-missing-plan: missing plan_id",
      nackPath: "/internal/events/outbox/evt-checkin-missing-plan/nack",
    },
    {
      name: "missing checkin_id",
      event: createCheckinEvent(
        { checkin_id: null },
        {
          event_id: "evt-checkin-missing-checkin",
          aggregate_id: "task-1",
        },
      ),
      warning:
        "[youpet] Malformed task.checkin_received event evt-checkin-missing-checkin: missing checkin_id",
      nackPath: "/internal/events/outbox/evt-checkin-missing-checkin/nack",
    },
    {
      name: "missing nested business payload",
      event: createCheckinEvent(
        {},
        {
          event_id: "evt-checkin-missing-payload",
          payload: { event_type: "task.checkin_received" },
        },
      ),
      warning:
        "[youpet] Malformed task.checkin_received event evt-checkin-missing-payload: missing payload.payload",
      nackPath: "/internal/events/outbox/evt-checkin-missing-payload/nack",
    },
  ]) {
    it(`nacks task check-in events with ${scenario.name} without writing flow state`, async () => {
      const logger = { warn: vi.fn() };
      const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
        createYouPetTempStateEnv(),
      );
      const { fetchFn, requests } = createFetch([scenario.event]);
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
      expect(pathnames(requests)).toEqual(["/internal/events/outbox", scenario.nackPath]);
      expect(requests[1]?.body).toEqual({
        error: "Malformed YouPet task.checkin_received payload",
      });
      expect(logger.warn).toHaveBeenCalledWith(scenario.warning);
    });
  }

  it("terminally acknowledges Core flow-id conflicts and does not retry them", async () => {
    const logger = { warn: vi.fn() };
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const { fetchFn, requests } = createFetch(
      [
        createCoreOutboxEvent(
          "health_plan.activated",
          { plan_id: "plan-1", pet_id: "pet-1" },
          {
            aggregate_type: "health_plan",
            aggregate_id: "plan-1",
            correlation_id: "corr-flow",
          },
        ),
      ],
      [
        {
          status: 409,
          body: {
            detail: {
              code: "flow_id_conflict",
              current_flow_id: "flow-existing",
              attempted_flow_id: "flow-attempted",
            },
          },
        },
      ],
    );
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      flowStore,
      logger,
    });

    const first = await consumer.pollOnce();
    const second = await consumer.pollOnce();

    expect(first).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(second).toEqual(first);
    expect(flowStore.lookupFlowByPlanId("plan-1")?.core_linked).toBe(true);
    expect(flowRequests(requests)).toHaveLength(1);
    expect(pathnames(requests)).not.toContain(
      "/internal/events/outbox/evt-health_plan.activated/nack",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("terminal health_plan.activated flow-link conflict"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"current_flow_id":"flow-existing"'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"attempted_flow_id":"flow-attempted"'),
    );
  });

  for (const scenario of [
    {
      name: "404 not found",
      failure: { status: 404, body: { detail: { code: "not_found" } } },
    },
    {
      name: "422 validation",
      failure: { status: 422, body: { detail: { code: "invalid_input" } } },
    },
    {
      name: "500 server error",
      failure: { status: 500, body: { detail: { code: "core_error" } } },
    },
    {
      name: "non-terminal 409",
      failure: { status: 409, body: { detail: { code: "permission_denied" } } },
    },
    {
      name: "network error",
      failure: { error: new Error("network down") },
    },
  ] satisfies Array<{ name: string; failure: FlowResponse }>) {
    it(`nacks ${scenario.name} flow writeback failures and retries on redelivery`, async () => {
      const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
      const { fetchFn, requests } = createFetch(
        [
          createCoreOutboxEvent(
            "health_plan.activated",
            { plan_id: "plan-1", pet_id: "pet-1" },
            {
              aggregate_type: "health_plan",
              aggregate_id: "plan-1",
              correlation_id: "corr-flow",
            },
          ),
        ],
        [scenario.failure, { body: { openclaw_flow_id: "linked" } }],
      );
      const consumer = new YouPetOutboxConsumer({
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        fetchFn,
        flowStore,
      });

      const first = await consumer.pollOnce();
      expect(first).toEqual({
        pulled: 1,
        processed: 1,
        acknowledged: 0,
        nacked: 1,
        skipped: 0,
      });
      expect(flowStore.lookupFlowByPlanId("plan-1")?.core_linked).toBe(false);

      const second = await consumer.pollOnce();
      expect(second).toEqual({
        pulled: 1,
        processed: 1,
        acknowledged: 1,
        nacked: 0,
        skipped: 0,
      });
      expect(flowStore.lookupFlowByPlanId("plan-1")?.core_linked).toBe(true);
      expect(flowRequests(requests)).toHaveLength(2);
      expect(pathnames(requests)).toEqual([
        "/internal/events/outbox",
        "/api/v1/health-plans/plan-1/flow",
        "/internal/events/outbox/evt-health_plan.activated/nack",
        "/internal/events/outbox",
        "/api/v1/health-plans/plan-1/flow",
        "/internal/events/outbox/evt-health_plan.activated/ack",
      ]);
    });
  }

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
    expect(pathnames(requests)).toEqual([
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
    expect(pathnames(requests)).toEqual([
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
    expect(pathnames(requests)).toEqual([
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
