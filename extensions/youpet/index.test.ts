import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
  createYouPetTestRuntimeState,
} from "./test/flow-store.fixture.js";
import {
  actionRequestEnvelopeFromCreate,
  createCoreOutboxEvent,
  TASK_MISSED_CORE_OUTBOX_EVENT,
} from "./test/outbox-consumer.fixture.js";

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

function createFetch(events: ReturnType<typeof createCoreOutboxEvent>[]) {
  const requests: CapturedRequest[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });

    if (parsed.pathname === "/internal/events/outbox") {
      return jsonResponse({ items: events });
    }
    if (parsed.pathname === "/api/v1/action-requests" && method === "POST") {
      return jsonResponse(actionRequestEnvelopeFromCreate(body as never), 201);
    }
    if (parsed.pathname === "/api/v1/action-requests" && method === "GET") {
      return jsonResponse({ items: [], count: 0 });
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
  });
  return { fetchFn, requests };
}

async function waitForRequestPath(requests: CapturedRequest[], path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (requests.some((request) => new URL(request.url).pathname === path)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${path}`);
}

function sourceCyclePaths(requests: CapturedRequest[]): string[] {
  return requests
    .filter(
      (request) =>
        !(request.method === "GET" && new URL(request.url).pathname === "/api/v1/action-requests"),
    )
    .map((request) => new URL(request.url).pathname);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("youpet plugin registration", () => {
  it("wires health plan proposal creation through the production outbox service path", async () => {
    const env = createYouPetTempStateEnv();
    const runtimeState = createYouPetTestRuntimeState(env);
    const openSyncKeyedStore = vi.fn(runtimeState.openSyncKeyedStore);
    const registerService = vi.fn();
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
    vi.stubGlobal("fetch", fetchFn);

    plugin.register(
      createTestPluginApi({
        id: "youpet",
        name: "YouPet Core",
        source: "test",
        pluginConfig: {
          enabled: true,
          coreBaseUrl: "https://core.example.com",
          serviceToken: "svc-token",
          tenantId: "00000000-0000-4000-8000-000000000101",
          pollIntervalMs: 60_000,
        },
        runtime: { state: { openSyncKeyedStore } } as never,
        registerService,
      }),
    );
    const service = registerService.mock.calls.at(0)?.at(0);
    if (!service) {
      throw new Error("expected youpet plugin to register the outbox service");
    }

    service.start({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      stateDir: "",
      config: {},
    });
    await waitForRequestPath(requests, "/internal/events/outbox/evt-health_plan.activated/ack");
    service.stop?.();

    const flowStore = createYouPetTestFlowStore(env).flowStore;
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(2);
    expect(flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301")).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      status: "active",
      core_linked: false,
      correlation_id: "corr-flow",
    });
    expect(sourceCyclePaths(requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
    const proposal = requests.find(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/api/v1/action-requests",
    );
    expect(proposal?.body).toMatchObject({
      action_type: "workflow.mutate",
      target: {
        type: "health_plan",
        id: "00000000-0000-4000-8000-000000000301",
      },
      payload: {
        fields: {
          openclaw_flow_id: flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301")
            ?.flow_id,
        },
      },
    });
  });

  it("wires task check-in flow advancement through the production outbox service path", async () => {
    const env = createYouPetTempStateEnv();
    const runtimeState = createYouPetTestRuntimeState(env);
    const openSyncKeyedStore = vi.fn(runtimeState.openSyncKeyedStore);
    const registerService = vi.fn();
    const { fetchFn, requests } = createFetch([
      createCoreOutboxEvent(
        "task.checkin_received",
        {
          task_id: "00000000-0000-4000-8000-000000000201",
          checkin_id: "00000000-0000-4000-8000-000000000601",
          plan_id: "00000000-0000-4000-8000-000000000301",
          pet_id: "00000000-0000-4000-8000-000000000501",
        },
        {
          aggregate_type: "checkin",
          aggregate_id: "00000000-0000-4000-8000-000000000601",
          correlation_id: "corr-checkin",
        },
      ),
    ]);
    vi.stubGlobal("fetch", fetchFn);

    plugin.register(
      createTestPluginApi({
        id: "youpet",
        name: "YouPet Core",
        source: "test",
        pluginConfig: {
          enabled: true,
          coreBaseUrl: "https://core.example.com",
          serviceToken: "svc-token",
          tenantId: "00000000-0000-4000-8000-000000000101",
          pollIntervalMs: 60_000,
        },
        runtime: { state: { openSyncKeyedStore } } as never,
        registerService,
      }),
    );
    const service = registerService.mock.calls.at(0)?.at(0);
    if (!service) {
      throw new Error("expected youpet plugin to register the outbox service");
    }

    service.start({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      stateDir: "",
      config: {},
    });
    await waitForRequestPath(requests, "/internal/events/outbox/evt-task.checkin_received/ack");
    service.stop?.();

    const flowStore = createYouPetTestFlowStore(env).flowStore;
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(2);
    expect(flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301")).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      status: "active",
      core_linked: false,
      correlation_id: "corr-checkin",
      checkin_count: 1,
    });
    expect(sourceCyclePaths(requests)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-task.checkin_received/ack",
    ]);
  });

  it("wires all built-in YouPet actions through the production outbox service path", async () => {
    const env = createYouPetTempStateEnv();
    const runtimeState = createYouPetTestRuntimeState(env);
    const openSyncKeyedStore = vi.fn(runtimeState.openSyncKeyedStore);
    const registerService = vi.fn();
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
      createCoreOutboxEvent(
        "task.checkin_received",
        {
          task_id: "00000000-0000-4000-8000-000000000201",
          checkin_id: "00000000-0000-4000-8000-000000000601",
          plan_id: "00000000-0000-4000-8000-000000000301",
          pet_id: "00000000-0000-4000-8000-000000000501",
        },
        {
          aggregate_type: "checkin",
          aggregate_id: "00000000-0000-4000-8000-000000000601",
          correlation_id: "corr-checkin",
        },
      ),
      TASK_MISSED_CORE_OUTBOX_EVENT,
    ]);
    vi.stubGlobal("fetch", fetchFn);

    plugin.register(
      createTestPluginApi({
        id: "youpet",
        name: "YouPet Core",
        source: "test",
        pluginConfig: {
          enabled: true,
          coreBaseUrl: "https://core.example.com",
          serviceToken: "svc-token",
          tenantId: "00000000-0000-4000-8000-000000000101",
          pollIntervalMs: 60_000,
        },
        runtime: { state: { openSyncKeyedStore } } as never,
        registerService,
      }),
    );
    const service = registerService.mock.calls.at(0)?.at(0);
    if (!service) {
      throw new Error("expected youpet plugin to register the outbox service");
    }

    service.start({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      stateDir: "",
      config: {},
    });
    await waitForRequestPath(requests, "/internal/events/outbox/evt-task.missed/ack");
    service.stop?.();

    const flowStore = createYouPetTestFlowStore(env).flowStore;
    const flow = flowStore.lookupFlowByPlanId("00000000-0000-4000-8000-000000000301");
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(2);
    expect(flow).toMatchObject({
      plan_id: "00000000-0000-4000-8000-000000000301",
      pet_id: "00000000-0000-4000-8000-000000000501",
      status: "active",
      core_linked: false,
      checkin_count: 1,
    });
    expect(sourceCyclePaths(requests)).toEqual([
      "/internal/events/outbox",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-health_plan.activated/ack",
      "/internal/events/outbox/evt-task.checkin_received/ack",
      "/api/v1/action-requests",
      "/internal/events/outbox/evt-task.missed/ack",
    ]);
    const proposals = requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/api/v1/action-requests",
    );
    expect(
      proposals.map((request) => (request.body as { action_type: string }).action_type),
    ).toEqual(["workflow.mutate", "task.escalate"]);
    expect(proposals[0]?.body).toMatchObject({
      payload: { fields: { openclaw_flow_id: flow?.flow_id } },
    });
    expect(proposals[1]?.body).toMatchObject({
      payload: {
        fields: {
          severity: "medium",
          summary: "Task missed the configured YouPet check-in threshold.",
        },
      },
    });
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/nack"))).toBe(false);
  });
});
