import { describe, expect, it, vi } from "vitest";
import {
  createCoreOutboxEvent,
  TASK_MISSED_CORE_OUTBOX_EVENT,
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
    if (parsed.pathname === "/api/v1/tasks/task-1/escalate") {
      return jsonResponse({ id: "alert-1", status: "open" }, 201);
    }
    return jsonResponse({ detail: { code: "not_found", message: parsed.pathname } }, 404);
  };
  return { fetchFn, requests };
}

const TASK_MISSED_REPLAY_PAYLOAD = {
  task_id: "task-1",
  plan_id: "plan-1",
  owner_user_id: "owner-1",
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
        createCoreOutboxEvent(eventType, { task_id: "task-1" }),
      ),
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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

  it("escalates missed tasks once the Core threshold is reached", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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
    const escalation = requests.find(
      (request) => new URL(request.url).pathname === "/api/v1/tasks/task-1/escalate",
    );
    expect(escalation).toMatchObject({
      method: "POST",
      body: {
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
    });
    expect(escalation?.headers["idempotency-key"]).toBe(
      "openclaw:youpet:payload-evt-task.missed:escalate",
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
          task_id: "task-1",
          missed_count: 2,
          missed_threshold: null,
        }),
      ],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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

  it("uses the same escalation idempotency key for redelivered task.missed events", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
    });

    await consumer.pollOnce();
    await consumer.pollOnce();

    const escalationKeys = requests
      .filter((request) => new URL(request.url).pathname === "/api/v1/tasks/task-1/escalate")
      .map((request) => request.headers["idempotency-key"]);

    expect(escalationKeys).toEqual([
      "openclaw:youpet:payload-evt-task.missed:escalate",
      "openclaw:youpet:payload-evt-task.missed:escalate",
    ]);
  });

  it("uses payload event identity for idempotency keys when delivery rows are regenerated", async () => {
    const events = [
      createTaskMissedReplayEvent("evt-task.missed-redeliver-1", "task-missed-business"),
    ];
    const { fetchFn, requests } = createFetch({ events });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
    });

    await consumer.pollOnce();
    events.splice(
      0,
      events.length,
      createTaskMissedReplayEvent("evt-task.missed-redeliver-2", "task-missed-business"),
    );
    await consumer.pollOnce();

    const escalationKeys = requests
      .filter((request) => new URL(request.url).pathname === "/api/v1/tasks/task-1/escalate")
      .map((request) => request.headers["idempotency-key"]);

    expect(escalationKeys).toEqual([
      "openclaw:youpet:task-missed-business:escalate",
      "openclaw:youpet:task-missed-business:escalate",
    ]);
  });

  it("uses distinct payload event identities for legitimate repeated task.missed escalations", async () => {
    const events = [
      createTaskMissedReplayEvent("evt-task.missed-distinct-1", "task-missed-business-1"),
    ];
    const { fetchFn, requests } = createFetch({ events });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
    });

    await consumer.pollOnce();
    events.splice(
      0,
      events.length,
      createTaskMissedReplayEvent("evt-task.missed-distinct-2", "task-missed-business-2"),
    );
    await consumer.pollOnce();

    const escalationKeys = requests
      .filter((request) => new URL(request.url).pathname === "/api/v1/tasks/task-1/escalate")
      .map((request) => request.headers["idempotency-key"]);

    expect(escalationKeys).toEqual([
      "openclaw:youpet:task-missed-business-1:escalate",
      "openclaw:youpet:task-missed-business-2:escalate",
    ]);
  });

  it("nacks processing failures without acknowledging the delivery", async () => {
    const logger = { warn: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [createCoreOutboxEvent("task.checkin_received", { task_id: "task-1" })],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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
    const { fetchFn } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/tasks/task-1/escalate",
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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
  });

  it("acknowledges terminal invalid task state conflicts from task escalation", async () => {
    const logger = { warn: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/tasks/task-1/escalate",
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
      "/api/v1/tasks/task-1/escalate",
      "/internal/events/outbox/evt-task.missed/ack",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("terminal task.missed escalation conflict"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"event_id":"payload-evt-task.missed"'),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"task_id":"task-1"'));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"current_status":"completed"'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"allowed_statuses":["pending","reminded","missed"]'),
    );
  });

  it("nacks task escalation 409 responses with a different error code", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/tasks/task-1/escalate",
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
      "/api/v1/tasks/task-1/escalate",
      "/internal/events/outbox/evt-task.missed/nack",
    ]);
  });

  it("nacks task escalation 409 responses with a non-JSON body", async () => {
    const { fetchFn, requests } = createFetch({
      events: [TASK_MISSED_CORE_OUTBOX_EVENT],
      failPath: "/api/v1/tasks/task-1/escalate",
      failStatus: 409,
      failText: "conflict",
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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
      "/api/v1/tasks/task-1/escalate",
      "/internal/events/outbox/evt-task.missed/nack",
    ]);
  });

  it("observably acknowledges unknown event types", async () => {
    const logger = { info: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [createCoreOutboxEvent("future.event_type", { task_id: "task-1" })],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
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

  it("nacks unknown event types when ackUnhandledEvents is false", async () => {
    const logger = { info: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [createCoreOutboxEvent("future.event_type", { task_id: "task-1" })],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
      logger,
      ackUnhandledEvents: false,
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
      "/internal/events/outbox/evt-future.event_type/nack",
    ]);
    expect(requests[1]?.body).toEqual({
      error: "unsupported_event_type: future.event_type",
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("skips empty event_id deliveries before dispatch, ack, or nack", async () => {
    const logger = { error: vi.fn() };
    const { fetchFn, requests } = createFetch({
      events: [
        createCoreOutboxEvent(
          "task.missed",
          {
            task_id: "task-1",
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
        task_id: "task-1",
        missed_count: 2,
        missed_threshold: 2,
      },
      {
        event_id: "evt-task.missed-missing-inner-id",
        payload: {
          aggregate: {
            id: "task-1",
            type: "task_instance",
          },
          correlation_id: "corr-1",
          event_type: "task.missed",
          event_version: 1,
          idempotency_key: "idem-task.missed",
          occurred_at: "2026-06-01T00:00:00Z",
          payload: {
            task_id: "task-1",
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
        YOUPET_OPENCLAW_POLL_INTERVAL_MS: "2500",
        YOUPET_OPENCLAW_MANAGE_FLOWS: "true",
      },
    });

    expect(settings.enabled).toBe(true);
    expect(settings.coreBaseUrl).toBe("https://cfg.example.com");
    expect(settings.serviceToken).toBe("env-token");
    expect(settings.outboxLimit).toBe(10);
    expect(settings.pollIntervalMs).toBe(2500);
    expect(settings.manageFlows).toBe(false);
  });

  it("wraps non-2xx Core responses", async () => {
    const { fetchFn } = createFetch({ failPath: "/internal/events/outbox" });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
    });

    await expect(consumer.pollOnce()).rejects.toBeInstanceOf(YouPetCoreRequestError);
  });
});
