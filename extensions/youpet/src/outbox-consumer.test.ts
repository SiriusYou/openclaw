import { describe, expect, it, vi } from "vitest";
import {
  createCoreOutboxEvent,
  TASK_MISSED_CORE_OUTBOX_EVENT,
} from "../test/outbox-consumer.fixture.js";
import {
  createYouPetOutboxConsumerSettingsFromConfig,
  YouPetCoreRequestError,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetch(routes: {
  events?: YouPetOutboxEventEnvelope[];
  failPath?: string;
}) {
  const requests: CapturedRequest[] = [];
  const fetchFn: YouPetOutboxFetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === "string" && init.body.length > 0
        ? JSON.parse(init.body)
        : undefined;
    requests.push({ url, method, headers, body });

    if (routes.failPath && parsed.pathname === routes.failPath) {
      return jsonResponse({ detail: { code: "core_error", message: "Core failed" } }, 500);
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

describe("YouPetOutboxConsumer", () => {
  it("pulls Core-envelope OpenClaw events and acknowledges handled no-op events", async () => {
    const handledNoOpEvents = [
      "wecom.message.received",
      "health_plan.activated",
      "task.checkin_received",
      "alert.acknowledged",
      "alert.resolved",
    ];
    const { fetchFn, requests } = createFetch({
      events: handledNoOpEvents.map((eventType) =>
        createCoreOutboxEvent(eventType, { task_id: "task-1" })
      ),
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
    });

    const result = await consumer.pollOnce();

    expect(result).toEqual({
      pulled: 5,
      processed: 5,
      acknowledged: 5,
      nacked: 0,
      skipped: 0,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-wecom.message.received/ack",
      "/internal/events/outbox/evt-health_plan.activated/ack",
      "/internal/events/outbox/evt-task.checkin_received/ack",
      "/internal/events/outbox/evt-alert.acknowledged/ack",
      "/internal/events/outbox/evt-alert.resolved/ack",
    ]);
    expect(new URL(requests[0]?.url ?? "").searchParams.get("consumer")).toBe("openclaw");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("limit")).toBe("20");
    expect(requests[0]?.headers.authorization).toBe("Bearer svc-token");
    expect(requests[0]?.headers["x-actor-id"]).toBe("openclaw-youpet-consumer");
    expect(
      requests.some((request) => new URL(request.url).pathname.endsWith("/escalate")),
    ).toBe(false);
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
      "openclaw:youpet:evt-task.missed:escalate",
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
    expect(
      requests.some((request) => new URL(request.url).pathname.endsWith("/escalate")),
    ).toBe(false);
    expect(requests.at(-1)?.url).toContain(
      "/internal/events/outbox/evt-task.missed-missing-business/nack",
    );
    expect(requests.at(-1)?.body).toEqual({ error: "Malformed YouPet task.missed payload" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[youpet] Malformed task.missed event evt-task.missed-missing-business: missing payload.payload",
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
    expect(
      requests.some((request) => new URL(request.url).pathname.endsWith("/escalate")),
    ).toBe(false);
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
      "openclaw:youpet:evt-task.missed:escalate",
      "openclaw:youpet:evt-task.missed:escalate",
    ]);
  });

  it("nacks processing failures without acknowledging the delivery", async () => {
    const { fetchFn, requests } = createFetch({
      events: [createCoreOutboxEvent("task.checkin_received", { task_id: "task-1" })],
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      fetchFn,
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

  it("builds settings from plugin config with env fallbacks", () => {
    const settings = createYouPetOutboxConsumerSettingsFromConfig({
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://cfg.example.com/",
        outboxLimit: 10,
      },
      env: {
        YOUPET_SERVICE_TOKEN: "env-token",
        YOUPET_OPENCLAW_POLL_INTERVAL_MS: "2500",
      },
    });

    expect(settings.enabled).toBe(true);
    expect(settings.coreBaseUrl).toBe("https://cfg.example.com");
    expect(settings.serviceToken).toBe("env-token");
    expect(settings.outboxLimit).toBe(10);
    expect(settings.pollIntervalMs).toBe(2500);
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
