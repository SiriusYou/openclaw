import { describe, expect, it, vi } from "vitest";
import {
  actionRequestEnvelopeFromCreate,
  createCoreOutboxEvent,
  TASK_MISSED_CORE_OUTBOX_EVENT,
} from "../test/outbox-consumer.fixture.js";
import {
  createYouPetOutboxConsumerSettingsFromConfig,
  isYouPetOutboxConsumerConfigured,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetch(routes: {
  events?: YouPetOutboxDeliveryEnvelope[];
  failPath?: string;
  failStatus?: number;
  failBody?: unknown;
  failText?: string;
}) {
  const requests: CapturedRequest[] = [];
  const fetchFn: YouPetOutboxFetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, headers, body });

    if (routes.failPath && parsed.pathname === routes.failPath) {
      if (routes.failText !== undefined) {
        return new Response(routes.failText, { status: routes.failStatus ?? 500 });
      }
      return jsonResponse(
        routes.failBody ?? { detail: { code: "core_error", message: "Core failed" } },
        routes.failStatus ?? 500,
      );
    }
    if (parsed.pathname === "/internal/events/outbox") {
      return jsonResponse({ items: routes.events ?? [] });
    }
    if (parsed.pathname === "/api/v1/action-requests" && method === "POST") {
      return jsonResponse(actionRequestEnvelopeFromCreate(body as never), 201);
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

const TASK_MISSED_REPLAY_PAYLOAD = {
  task_id: "00000000-0000-4000-8000-000000000201",
  plan_id: "00000000-0000-4000-8000-000000000301",
  owner_user_id: "00000000-0000-4000-8000-000000000701",
  missed_count: 2,
  missed_threshold: 2,
  due_at: "2026-06-01T00:00:00Z",
} satisfies Record<string, unknown>;

function createTaskMissedReplayEvent(
  deliveryId: string,
  innerEventId: string,
): YouPetOutboxDeliveryEnvelope {
  return createCoreOutboxEvent(
    "task.missed",
    TASK_MISSED_REPLAY_PAYLOAD,
    {
      event_id: deliveryId,
    },
    {
      innerEventId,
    },
  );
}

describe("YouPetOutboxConsumer", () => {
  it("pulls Core-envelope OpenClaw events and acknowledges handled no-op events", async () => {
    const handledNoOpEvents = ["wecom.message.received", "alert.acknowledged", "alert.resolved"];
    const { fetchFn, requests } = createFetch({
      events: handledNoOpEvents.map((eventType) =>
        createCoreOutboxEvent(eventType, { task_id: "00000000-0000-4000-8000-000000000201" }),
      ),
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 3,
      processed: 3,
      acknowledged: 3,
      nacked: 0,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-wecom.message.received/ack",
      "/internal/events/outbox/evt-alert.acknowledged/ack",
      "/internal/events/outbox/evt-alert.resolved/ack",
    ]);
    expect(new URL(requests[0]?.url ?? "").searchParams.get("consumer")).toBe("openclaw");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("limit")).toBe("20");
    expect(requests[0]?.headers.authorization).toBe("Bearer svc-token");
    expect(requests[0]?.headers["x-actor-id"]).toBe("openclaw-youpet-consumer");
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/escalate"))).toBe(
      false,
    );
  });

  it("persists a high-risk approval proposal before acknowledging a missed task", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    const proposal = requests.find(
      (request) => new URL(request.url).pathname === "/api/v1/action-requests",
    );
    expect(proposal).toMatchObject({
      method: "POST",
      body: {
        tenant_id: "00000000-0000-4000-8000-000000000101",
        action_type: "task.escalate",
        target: {
          type: "task_instance",
          id: "00000000-0000-4000-8000-000000000201",
        },
        risk: "high",
        policy: {
          outcome: "require_approval",
          required_approver_class: "operator",
        },
        payload: {
          mode: "inline",
          fields: {
            task_id: "00000000-0000-4000-8000-000000000201",
            severity: "medium",
            summary: "Task missed the configured YouPet check-in threshold.",
          },
        },
      },
    });
    expect(proposal?.headers["idempotency-key"]).toMatch(
      /^openclaw\.youpet\.proposal\.[0-9a-f]{64}$/u,
    );
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/escalate"))).toBe(
      false,
    );
    expect(requests.at(-1)?.url).toContain("/internal/events/outbox/evt-task.missed/ack");
  });

  it("nacks malformed task.missed payloads without acknowledging the delivery", async () => {
    const logger = { warn: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent(
          "task.missed",
          {},
          {
            event_id: "evt-task.missed-missing-business",
            payload: {
              event_id: "payload-evt-task.missed-missing-business",
              event_type: "task.missed",
              event_version: 1,
              payload: null,
              producer: "youpet-core",
            },
          },
        ),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
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
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/escalate"))).toBe(
      false,
    );
    expect(requests.at(-1)?.url).toContain(
      "/internal/events/outbox/evt-task.missed-missing-business/nack",
    );
    expect(requests.at(-1)?.body).toEqual({ error: "Malformed YouPet task.missed payload" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Malformed task.missed event payload-evt-task.missed-missing-business: missing payload.payload",
    );
  });

  it("does not escalate when Core omits the missed threshold", async () => {
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent("task.missed", {
          task_id: "00000000-0000-4000-8000-000000000201",
          missed_count: 2,
          missed_threshold: null,
        }),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/escalate"))).toBe(
      false,
    );
  });

  it("uses the same proposal idempotency key for redelivered task.missed events", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    await consumer.pollOnce();
    await consumer.pollOnce();

    const proposalKeys = requests
      .filter((request) => new URL(request.url).pathname === "/api/v1/action-requests")
      .map((request) => request.headers["idempotency-key"]);

    expect(proposalKeys).toHaveLength(2);
    expect(proposalKeys[0]).toMatch(/^openclaw\.youpet\.proposal\.[0-9a-f]{64}$/u);
    expect(proposalKeys[1]).toBe(proposalKeys[0]);
  });

  it("uses payload event identity for idempotency keys when delivery rows are regenerated", async () => {
    const events = [
      createTaskMissedReplayEvent("evt-task.missed-redeliver-1", "task-missed-business"),
    ];
    const { fetchFn, requests } = createFetch({ events });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    await consumer.pollOnce();
    events.splice(
      0,
      events.length,
      createTaskMissedReplayEvent("evt-task.missed-redeliver-2", "task-missed-business"),
    );
    await consumer.pollOnce();

    const proposalKeys = requests
      .filter((request) => new URL(request.url).pathname === "/api/v1/action-requests")
      .map((request) => request.headers["idempotency-key"]);

    expect(proposalKeys).toHaveLength(2);
    expect(proposalKeys[1]).toBe(proposalKeys[0]);
  });

  it("uses distinct payload event identities for legitimate repeated task.missed escalations", async () => {
    const events = [
      createTaskMissedReplayEvent("evt-task.missed-distinct-1", "task-missed-business-1"),
    ];
    const { fetchFn, requests } = createFetch({ events });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    await consumer.pollOnce();
    events.splice(
      0,
      events.length,
      createTaskMissedReplayEvent("evt-task.missed-distinct-2", "task-missed-business-2"),
    );
    await consumer.pollOnce();

    const proposalKeys = requests
      .filter((request) => new URL(request.url).pathname === "/api/v1/action-requests")
      .map((request) => request.headers["idempotency-key"]);

    expect(proposalKeys).toHaveLength(2);
    expect(proposalKeys[0]).not.toBe(proposalKeys[1]);
  });

  it("nacks processing failures without acknowledging the delivery", async () => {
    const logger = { warn: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent("task.checkin_received", {
          task_id: "00000000-0000-4000-8000-000000000201",
        }),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      logger,
      handlers: {
        "task.checkin_received": () => {
          throw new Error("handler failed");
        },
      },
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/nack",
    ]);
    expect(requests[1]?.body).toEqual({ error: "handler failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Nacking malformed or failed task.checkin_received delivery evt-task.checkin_received (domain event payload-evt-task.checkin_received): handler failed",
    );
  });

  it("surfaces Core request failures to the caller", async () => {
    const logger = { warn: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/action-requests",
      failBody: {
        detail: { code: "core_error", message: "authorization=secret-value" },
      },
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
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
    expect(requests.at(-1)?.body).toEqual({
      error: "YouPet Core ActionRequest request failed 500 /api/v1/action-requests",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.not.stringContaining("secret-value"));
  });

  it("nacks when proposal persistence returns a downstream-shaped conflict", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/action-requests",
      failStatus: 409,
      failBody: {
        detail: {
          code: "invalid_task_state",
          current_status: "completed",
          allowed_statuses: ["pending", "reminded", "missed"],
        },
      },
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-task.missed/nack",
    ]);
  });

  it("nacks ActionRequest creation 409 responses with a different error code", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/action-requests",
      failStatus: 409,
      failBody: {
        detail: {
          code: "permission_denied",
          message: "blocked",
        },
      },
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-task.missed/nack",
    ]);
  });

  it("nacks ActionRequest creation 409 responses with a non-JSON body", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/action-requests",
      failStatus: 409,
      failText: "conflict",
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-task.missed/nack",
    ]);
  });

  it("observably acknowledges unknown event types", async () => {
    const logger = { info: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent("future.event_type", {
          task_id: "00000000-0000-4000-8000-000000000201",
        }),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      logger,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-future.event_type/ack",
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "[youpet] Acknowledging unhandled outbox event type: future.event_type",
    );
  });

  it("nacks unknown event types on every poll when ackUnhandledEvents is false", async () => {
    const logger = { info: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent("future.event_type", {
          task_id: "00000000-0000-4000-8000-000000000201",
        }),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      logger,
      ackUnhandledEvents: false,
    });

    const first = await consumer.pollOnce();
    const second = await consumer.pollOnce();

    expect(first).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(second).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 1,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-future.event_type/nack",
      "/internal/events/outbox",
      "/internal/events/outbox/evt-future.event_type/nack",
    ]);
    expect(requests[1]?.body).toEqual({
      error: "unsupported_event_type: future.event_type",
    });
    expect(requests[3]?.body).toEqual(requests[1]?.body);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      "[youpet] Nacking unsupported future.event_type delivery evt-future.event_type (domain event payload-evt-future.event_type)",
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      "[youpet] Nacking unsupported future.event_type delivery evt-future.event_type (domain event payload-evt-future.event_type)",
    );
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/ack"))).toBe(false);
  });

  it("acknowledges handled events when ackUnhandledEvents is false", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      ackUnhandledEvents: false,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 1,
      nacked: 0,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-task.missed/ack",
    ]);
  });

  it("skips empty event_id deliveries before dispatch, ack, or nack", async () => {
    const logger = { error: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent(
          "task.missed",
          {
            task_id: "00000000-0000-4000-8000-000000000201",
            missed_count: 2,
            missed_threshold: 2,
          },
          {
            event_id: "",
          },
        ),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
      logger,
    });

    const firstResult = await consumer.pollOnce();
    const secondResult = await consumer.pollOnce();

    expect(firstResult).toEqual({
      pulled: 1,
      processed: 1,
      acknowledged: 0,
      nacked: 0,
      skipped: 1,
    });
    expect(secondResult).toEqual(firstResult);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox",
    ]);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenNthCalledWith(
      1,
      "[youpet] Skipping outbox item with missing event_id",
    );
  });

  it("nacks supported deliveries missing payload.event_id before side effects", async () => {
    const logger = { warn: vi.fn() };
    const malformed = createCoreOutboxEvent(
      "task.missed",
      {
        task_id: "00000000-0000-4000-8000-000000000201",
        missed_count: 2,
        missed_threshold: 2,
      },
      {
        event_id: "evt-task.missed-missing-inner-id",
        payload: {
          aggregate: {
            id: "00000000-0000-4000-8000-000000000201",
            type: "task_instance",
          },
          correlation_id: "corr-1",
          event_type: "task.missed",
          event_version: 1,
          idempotency_key: "idem-task.missed",
          occurred_at: "2026-06-01T00:00:00Z",
          payload: {
            task_id: "00000000-0000-4000-8000-000000000201",
            missed_count: 2,
            missed_threshold: 2,
          },
          producer: "youpet-core",
        },
      },
    );
    const { fetchFn, requests } = createFetch({
      events: [malformed],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
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
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.missed-missing-inner-id/nack",
    ]);
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/escalate"))).toBe(
      false,
    );
    expect(requests.at(-1)?.body).toEqual({
      error: "YouPet outbox item missing payload.event_id",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Nacking malformed outbox item evt-task.missed-missing-inner-id: YouPet outbox item missing payload.event_id",
    );
  });

  it("builds settings from plugin config with env fallbacks", () => {
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://cfg.example.com/",
        outboxLimit: 10,
        manageFlows: false,
      },
      env: {
        YOUPET_SERVICE_TOKEN: "env-token",
        YOUPET_TENANT_ID: "00000000-0000-4000-8000-000000000101",
        YOUPET_OPENCLAW_POLL_INTERVAL_MS: "2500",
        YOUPET_OPENCLAW_MANAGE_FLOWS: "true",
      },
    });

    expect(settings.enabled).toBe(true);
    expect(settings.coreBaseUrl).toBe("https://cfg.example.com");
    expect(settings.serviceToken).toBe("env-token");
    expect(settings.tenantId).toBe("00000000-0000-4000-8000-000000000101");
    expect(settings.outboxLimit).toBe(10);
    expect(settings.pollIntervalMs).toBe(2500);
    expect(settings.manageFlows).toBe(false);
    expect(isYouPetOutboxConsumerConfigured(settings)).toBe(true);
    expect(isYouPetOutboxConsumerConfigured({ ...settings, tenantId: "shared" })).toBe(false);
  });

  it("wraps non-2xx Core responses", async () => {
    const { fetchFn } = createFetch({ failPath: "/internal/events/outbox" });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: "00000000-0000-4000-8000-000000000101",
      fetchFn,
    });

    await expect(consumer.pollOnce()).rejects.toBeInstanceOf(YouPetCoreRequestError);
  });
});
