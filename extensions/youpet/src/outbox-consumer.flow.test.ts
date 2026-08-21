import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
} from "../test/flow-store.fixture.js";
import {
  actionRequestEnvelopeFromCreate,
  createCoreOutboxEvent,
} from "../test/outbox-consumer.fixture.js";
import {
  createYouPetOutboxConsumerSettingsFromConfig,
  YouPetCoreRequestError,
  YouPetOutboxConsumer,
  type YouPetOutboxDeliveryEnvelope,
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

function createFetch(events: YouPetOutboxDeliveryEnvelope[], flowResponses: FlowResponse[] = []) {
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
    if (parsed.pathname === "/api/v1/action-requests" && method === "POST") {
      return jsonResponse(actionRequestEnvelopeFromCreate(body as never), 201);
    }
    if (/^\/api\/v1\/health-plans\/[^/]+\/flow$/.test(parsed.pathname)) {
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

function actionRequestCreates(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter(
    (request) =>
      request.method === "POST" && new URL(request.url).pathname === "/api/v1/action-requests",
  );
}

function createCheckinEvent(
  businessPayload: Record<string, unknown> = {},
  overrides: Partial<YouPetOutboxDeliveryEnvelope> = {},
  innerEventId?: string,
): YouPetOutboxDeliveryEnvelope {
  const checkinId =
    typeof businessPayload.checkin_id === "string"
      ? businessPayload.checkin_id
      : "00000000-0000-4000-8000-000000000601";
  return createCoreOutboxEvent(
    "task.checkin_received",
    {
      task_id: "00000000-0000-4000-8000-000000000201",
      checkin_id: checkinId,
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      ...businessPayload,
    },
    {
      aggregate_type: "checkin",
      aggregate_id: checkinId,
      ...overrides,
    },
    innerEventId ? { innerEventId } : undefined,
  );
}

function createReplayCheckinEvent(params: {
  deliveryId: string;
  innerEventId: string;
  checkinId: string;
}): YouPetOutboxDeliveryEnvelope {
  return createCheckinEvent(
    { checkin_id: params.checkinId },
    {
      event_id: params.deliveryId,
      aggregate_id: params.checkinId,
    },
    params.innerEventId,
  );
}

function createReplayHealthPlanActivatedEvent(params: {
  deliveryId: string;
  innerEventId: string;
  planId?: string;
  petId?: string;
}): YouPetOutboxDeliveryEnvelope {
  return createCoreOutboxEvent(
    "health_plan.activated",
    {
      plan_id: params.planId ?? "00000000-0000-4000-8000-000000000301",
      pet_id: params.petId ?? "00000000-0000-4000-8000-000000000501",
    },
    {
      event_id: params.deliveryId,
      aggregate_type: "health_plan",
      aggregate_id: params.planId ?? "00000000-0000-4000-8000-000000000301",
      correlation_id: "corr-flow",
    },
    { innerEventId: params.innerEventId },
  );
}

afterEach(async () => {
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPetOutboxConsumer health plan flows", () => {
  it("persists a flow-link ActionRequest before acknowledging activation", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        {
          plan_id: "00000000-0000-4000-8000-000000000301",
          pet_id: "00000000-0000-4000-8000-000000000501",
        },
        {
          aggregate_type: "health_plan",
          aggregate_id: "00000000-0000-4000-8000-000000000301",
          correlation_id: "corr-flow",
        },
      ),
    ]);
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        tenantId: "00000000-0000-4000-8000-000000000101",
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
    const flow = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");
    expect(flow).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      status: "active",
      core_linked: false,
      correlation_id: "corr-flow",
      created_from_event_id: "payload-evt-health_plan.activated",
      checkin_count: 0,
      last_checkin_at: null,
    });
    expect(flow?.flow_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(flowStore.lookupProcessedEvent("payload-evt-health_plan.activated")).toMatchObject({
      flow_id: flow?.flow_id,
      event_type: "health_plan.activated",
      aggregate_id: "00000000-0000-4000-8000-000000000301",
    });
    const proposals = actionRequestCreates(requests);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      method: "POST",
      body: {
        tenant_id: "00000000-0000-4000-8000-000000000101",
        action_type: "workflow.mutate",
        target: {
          type: "health_plan",
          id: "00000000-0000-4000-8000-000000000301",
        },
        risk: "low",
        policy: { outcome: "allow" },
        payload: {
          mode: "inline",
          fields: {
            health_plan_id: "00000000-0000-4000-8000-000000000301",
            openclaw_flow_id: flow?.flow_id,
          },
        },
      },
    });
    expect(proposals[0]?.headers["idempotency-key"]).toMatch(
      /^openclaw\.youpet\.proposal\.[0-9a-f]{64}$/u,
    );
    expect(proposals[0]?.headers["x-correlation-id"]).toBe("corr-flow");
    expect(flowRequests(requests)).toHaveLength(0);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
  });

  it("reuses the same durable proposal until a dispatcher links the flow", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        {
          plan_id: "00000000-0000-4000-8000-000000000301",
          pet_id: "00000000-0000-4000-8000-000000000501",
        },
        {
          aggregate_type: "health_plan",
          aggregate_id: "00000000-0000-4000-8000-000000000301",
          correlation_id: "corr-flow",
        },
      ),
    ]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
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
    expect(flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301")?.core_linked).toBe(
      false,
    );
    const proposals = actionRequestCreates(requests);
    expect(proposals).toHaveLength(2);
    expect(proposals[1]?.headers["idempotency-key"]).toBe(proposals[0]?.headers["idempotency-key"]);
    expect(flowRequests(requests)).toHaveLength(0);
  });

  it("dedupes replayed health_plan.activated deliveries by payload event_id while acking each delivery row", async () => {
    const { flowStore, processedEvents } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const events = [
      createReplayHealthPlanActivatedEvent({
        deliveryId: "evt-health_plan.activated-redelivery-1",
        innerEventId: "health-plan-activation-business-1",
      }),
    ];
    const { fetchFn, requests } = createFetch(events);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      flowStore,
    });

    const first = await consumer.pollOnce();
    events.splice(
      0,
      events.length,
      createReplayHealthPlanActivatedEvent({
        deliveryId: "evt-health_plan.activated-redelivery-2",
        innerEventId: "health-plan-activation-business-1",
      }),
    );
    const second = await consumer.pollOnce();

    expect(first).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(second).toEqual(first);
    const flow = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");
    expect(flow).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      core_linked: false,
      correlation_id: "corr-flow",
      created_from_event_id: "health-plan-activation-business-1",
      checkin_count: 0,
      last_checkin_at: null,
    });
    const proposals = actionRequestCreates(requests);
    expect(proposals).toHaveLength(2);
    expect(proposals[1]?.headers["idempotency-key"]).toBe(proposals[0]?.headers["idempotency-key"]);
    expect(flowRequests(requests)).toHaveLength(0);
    expect(flowStore.lookupProcessedEvent("health-plan-activation-business-1")).toMatchObject({
      flow_id: flow?.flow_id,
      event_id: "health-plan-activation-business-1",
      event_type: "health_plan.activated",
      aggregate_id: "00000000-0000-4000-8000-000000000301",
    });
    expect(
      flowStore.lookupProcessedEvent("evt-health_plan.activated-redelivery-1"),
    ).toBeUndefined();
    expect(
      flowStore.lookupProcessedEvent("evt-health_plan.activated-redelivery-2"),
    ).toBeUndefined();
    expect(
      processedEvents
        .entries()
        .filter((entry) => entry.key === "processed.health-plan-activation-business-1"),
    ).toHaveLength(1);
    expect(
      processedEvents
        .entries()
        .filter((entry) => entry.key.includes("evt-health_plan.activated-redelivery-")),
    ).toEqual([]);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-health_plan.activated-redelivery-1/ack",
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-health_plan.activated-redelivery-2/ack",
    ]);
  });

  it("replays the same durable proposal after an ack failure", async () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const deliveryId = "evt-health_plan.activated-ack-retry";
    const innerEventId = "health-plan-activation-business-ack-retry";
    const replayedEvent = createReplayHealthPlanActivatedEvent({
      deliveryId,
      innerEventId,
    });
    const pollResponses: YouPetOutboxDeliveryEnvelope[][] = [[replayedEvent], [replayedEvent]];
    const requests: CapturedRequest[] = [];
    let ackAttempts = 0;
    const fetchFn: YouPetOutboxFetch = async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body =
        typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, headers, body });

      if (parsed.pathname === "/internal/events/outbox") {
        return jsonResponse({ items: pollResponses.shift() ?? [] });
      }
      if (parsed.pathname === "/api/v1/action-requests" && method === "POST") {
        return jsonResponse(actionRequestEnvelopeFromCreate(body as never), 201);
      }
      if (parsed.pathname === `/internal/events/outbox/${deliveryId}/ack`) {
        ackAttempts += 1;
        if (ackAttempts === 1) {
          return jsonResponse(
            { detail: { code: "ack_failed", message: "delivery settlement retry" } },
            500,
          );
        }
        return jsonResponse({
          event_id: deliveryId,
          consumer: "openclaw",
          state: "delivered",
          attempts: 1,
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
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      flowStore,
    });

    await expect(consumer.pollOnce()).rejects.toBeInstanceOf(YouPetCoreRequestError);
    const second = await consumer.pollOnce();

    expect(second).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    const flow = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");
    expect(flow).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      core_linked: false,
      created_from_event_id: innerEventId,
      checkin_count: 0,
      last_checkin_at: null,
    });
    expect(flows.entries()).toHaveLength(1);
    const proposals = actionRequestCreates(requests);
    expect(proposals).toHaveLength(2);
    expect(proposals[1]?.headers["idempotency-key"]).toBe(proposals[0]?.headers["idempotency-key"]);
    expect(flowRequests(requests)).toHaveLength(0);
    expect(ackAttempts).toBe(2);
    expect(flowStore.lookupProcessedEvent(innerEventId)).toMatchObject({
      flow_id: flow?.flow_id,
      event_id: innerEventId,
      event_type: "health_plan.activated",
      aggregate_id: "00000000-0000-4000-8000-000000000301",
    });
    expect(processedEvents.entries()).toHaveLength(1);
    expect(
      processedEvents.entries().filter((entry) => entry.key === `processed.${innerEventId}`),
    ).toHaveLength(1);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      `/internal/events/outbox/${deliveryId}/ack`,
      "/internal/events/outbox",
      "/api/v1/action-requests",
      `/internal/events/outbox/${deliveryId}/ack`,
    ]);
  });

  it("advances task check-ins through the production settings path", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "00000000-0000-4000-8000-000000000301",
      planId: "00000000-0000-4000-8000-000000000301",
      petId: "00000000-0000-4000-8000-000000000501",
      correlationId: "corr-flow",
    });
    const { fetchFn, requests } = createFetch([createCheckinEvent()]);
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        tenantId: "00000000-0000-4000-8000-000000000101",
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
    const flow = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");
    expect(flow).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      status: "active",
      checkin_count: 1,
    });
    expect(flow?.last_checkin_at).toEqual(expect.any(String));
    expect(flowStore.lookupProcessedEvent("payload-evt-task.checkin_received")).toMatchObject({
      flow_id: flow?.flow_id,
      event_type: "task.checkin_received",
      aggregate_id: "00000000-0000-4000-8000-000000000601",
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
      aggregateId: "00000000-0000-4000-8000-000000000301",
      planId: "00000000-0000-4000-8000-000000000301",
      petId: "00000000-0000-4000-8000-000000000501",
      correlationId: "corr-flow",
    });
    const { fetchFn, requests } = createFetch([createCheckinEvent()]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
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
    expect(
      flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301")?.checkin_count,
    ).toBe(1);
    expect(
      processedEvents
        .entries()
        .filter((entry) => entry.value.event_id === "payload-evt-task.checkin_received"),
    ).toHaveLength(1);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
    ]);
  });

  it("dedupes semantic replay by payload event_id but advances distinct check-ins", async () => {
    const { flowStore, processedEvents } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "00000000-0000-4000-8000-000000000301",
      planId: "00000000-0000-4000-8000-000000000301",
      petId: "00000000-0000-4000-8000-000000000501",
      correlationId: "corr-flow",
    });
    const firstDelivery = createReplayCheckinEvent({
      deliveryId: "evt-task.checkin_received-redelivery-1",
      innerEventId: "checkin-business-1",
      checkinId: "00000000-0000-4000-8000-000000000601",
    });
    const replayDelivery = createReplayCheckinEvent({
      deliveryId: "evt-task.checkin_received-redelivery-2",
      innerEventId: "checkin-business-1",
      checkinId: "00000000-0000-4000-8000-000000000601",
    });
    const secondBusinessDelivery = createReplayCheckinEvent({
      deliveryId: "evt-task.checkin_received-redelivery-3",
      innerEventId: "checkin-business-2",
      checkinId: "checkin-2",
    });

    const events: YouPetOutboxDeliveryEnvelope[] = [firstDelivery];
    const { fetchFn, requests } = createFetch(events);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      flowStore,
    });

    const first = await consumer.pollOnce();
    events.splice(0, events.length, replayDelivery);
    const second = await consumer.pollOnce();
    events.splice(0, events.length, secondBusinessDelivery);
    const third = await consumer.pollOnce();

    expect(first).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(
      flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301")?.checkin_count,
    ).toBe(2);
    expect(
      processedEvents.entries().filter((entry) => entry.value.event_id === "checkin-business-1"),
    ).toHaveLength(1);
    expect(
      processedEvents.entries().filter((entry) => entry.value.event_id === "checkin-business-2"),
    ).toHaveLength(1);
    expect(pathnames(requests)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received-redelivery-1/ack",
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received-redelivery-2/ack",
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received-redelivery-3/ack",
    ]);
  });

  it("lazy-creates an unlinked flow and proposes linking it on activation", async () => {
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
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn: checkinFetch.fetchFn,
      flowStore,
    });

    const checkinResult = await checkinConsumer.pollOnce();
    const created = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");

    expect(checkinResult).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(created).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      core_linked: false,
      correlation_id: "corr-checkin",
      created_from_event_id: "payload-evt-task.checkin_received",
      checkin_count: 1,
    });
    expect(flowRequests(checkinFetch.requests)).toHaveLength(0);

    const activationFetch = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        {
          plan_id: "00000000-0000-4000-8000-000000000301",
          pet_id: "00000000-0000-4000-8000-000000000501",
        },
        {
          aggregate_type: "health_plan",
          aggregate_id: "00000000-0000-4000-8000-000000000301",
          correlation_id: "corr-activation",
        },
      ),
    ]);
    const activationConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn: activationFetch.fetchFn,
      flowStore,
    });

    const activationResult = await activationConsumer.pollOnce();
    const linked = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");

    expect(activationResult).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(linked).toMatchObject({
      flow_id: created?.flow_id,
      core_linked: false,
      checkin_count: 1,
      correlation_id: "corr-checkin",
    });
    expect(flows.entries()).toHaveLength(1);
    expect(actionRequestCreates(activationFetch.requests)).toHaveLength(1);
    expect(flowRequests(activationFetch.requests)).toHaveLength(0);
    expect(pathnames(activationFetch.requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
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
        tenantId: "00000000-0000-4000-8000-000000000101",
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
        "[youpet] Malformed task.checkin_received event payload-evt-checkin-missing-plan: missing plan_id",
      nackPath: "/internal/events/outbox/evt-checkin-missing-plan/nack",
    },
    {
      name: "missing checkin_id",
      event: createCheckinEvent(
        { checkin_id: null },
        {
          event_id: "evt-checkin-missing-checkin",
          aggregate_id: "00000000-0000-4000-8000-000000000201",
        },
      ),
      warning:
        "[youpet] Malformed task.checkin_received event payload-evt-checkin-missing-checkin: missing checkin_id",
      nackPath: "/internal/events/outbox/evt-checkin-missing-checkin/nack",
    },
    {
      name: "missing nested business payload",
      event: createCheckinEvent(
        {},
        {
          event_id: "evt-checkin-missing-payload",
          payload: {
            event_id: "payload-evt-checkin-missing-payload",
            event_type: "task.checkin_received",
          },
        },
      ),
      warning:
        "[youpet] Malformed task.checkin_received event payload-evt-checkin-missing-payload: missing payload.payload",
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
        tenantId: "00000000-0000-4000-8000-000000000101",
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

  it("nacks malformed health_plan.activated payloads without creating a flow", async () => {
    const logger = { warn: vi.fn() };
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        { pet_id: "00000000-0000-4000-8000-000000000501" },
        {
          event_id: "evt-health-plan-missing-plan",
          aggregate_type: "health_plan",
          aggregate_id: "00000000-0000-4000-8000-000000000301",
        },
      ),
    ]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
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
      "[youpet] Malformed health_plan.activated event payload-evt-health-plan-missing-plan: missing plan_id",
    );
  });

  it("rejects a non-UUID health plan target before writing local flow state", async () => {
    const logger = { warn: vi.fn() };
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        { plan_id: "plan-1", pet_id: "00000000-0000-4000-8000-000000000501" },
        {
          event_id: "evt-health-plan-invalid-plan",
          aggregate_type: "health_plan",
          aggregate_id: "plan-1",
        },
      ),
    ]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      flowStore,
      logger,
    });

    expect(await consumer.pollOnce()).toMatchObject({ acknowledged: 0, nacked: 1 });
    expect(flows.entries()).toEqual([]);
    expect(processedEvents.entries()).toEqual([]);
    expect(actionRequestCreates(requests)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Malformed health_plan.activated event payload-evt-health-plan-invalid-plan: plan_id must be a UUID",
    );
  });

  it("acknowledges health_plan.activated without flow creation when manageFlows is disabled", async () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "health_plan.activated",
        {
          plan_id: "00000000-0000-4000-8000-000000000301",
          pet_id: "00000000-0000-4000-8000-000000000501",
        },
        {
          aggregate_type: "health_plan",
          aggregate_id: "00000000-0000-4000-8000-000000000301",
        },
      ),
    ]);
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        tenantId: "00000000-0000-4000-8000-000000000101",
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
          aggregate_id: "00000000-0000-4000-8000-000000000301",
          // Core nests business fields under payload.payload; an envelope whose
          // payload object lacks the nested payload must nack, not silently drop.
          payload: {
            event_id: "payload-evt-health-plan-missing-payload",
            event_type: "health_plan.activated",
          },
        },
      ),
    ]);
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
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
      "[youpet] Malformed health_plan.activated event payload-evt-health-plan-missing-payload: missing payload.payload",
    );
  });
});
