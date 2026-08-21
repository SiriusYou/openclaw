import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildYouPetActionRequestProposal } from "./src/action-request-routing.js";
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
  TEST_TASK_ID,
  TEST_TENANT_ID,
} from "./test/outbox-consumer.fixture.js";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
};

const PLUGIN_RESTART_ACTOR_ID = "openclaw-youpet-consumer";
const PLUGIN_RESTART_CURSOR_PARAMS = {
  tenantId: TEST_TENANT_ID,
  actorId: PLUGIN_RESTART_ACTOR_ID,
  approvalState: "approved",
  executionState: "not_started",
} as const;

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
  await waitForCondition(
    () => requests.some((request) => new URL(request.url).pathname === path),
    path,
  );
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${description}`);
}

function sourceCyclePaths(requests: CapturedRequest[]): string[] {
  return requests
    .filter(
      (request) =>
        !(request.method === "GET" && new URL(request.url).pathname === "/api/v1/action-requests"),
    )
    .map((request) => new URL(request.url).pathname);
}

function createPluginRestartFetch(
  cursors: Array<string | undefined>,
  foreignTemplate: ReturnType<typeof actionRequestEnvelopeFromCreate>,
  cycleTailSignals: { count: number },
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const method = init?.method ?? "GET";
    if (url.pathname === "/internal/events/outbox") {
      return jsonResponse({ items: [] });
    }
    if (url.pathname !== "/api/v1/action-requests" || method !== "GET") {
      return jsonResponse({ detail: { code: "not_found", message: url.pathname } }, 404);
    }
    if (
      url.searchParams.get("approval_state") === "not_required" &&
      url.searchParams.get("execution_state") === "not_started" &&
      !url.searchParams.has("cursor")
    ) {
      cycleTailSignals.count += 1;
      return jsonResponse({ items: [], count: 0, next_cursor: null });
    }
    if (
      url.searchParams.get("approval_state") !== "approved" ||
      url.searchParams.get("execution_state") !== "not_started"
    ) {
      return jsonResponse({ items: [], count: 0, next_cursor: null });
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    cursors.push(cursor);
    const pageIndex = cursor ? Number(cursor.replace("cursor-", "")) : 0;
    if (pageIndex === 200) {
      return jsonResponse({ items: [], count: 0, next_cursor: null });
    }
    const item = structuredClone(foreignTemplate);
    item.action_request.id = `00000000-0000-4000-8000-${String(80_000 + pageIndex).padStart(12, "0")}`;
    item.action_request.proposer = { type: "agent", id: `foreign-agent-${pageIndex}` };
    return jsonResponse({ items: [item], count: 1, next_cursor: `cursor-${pageIndex + 1}` });
  });
}

function startPluginRestartService(
  env: ReturnType<typeof createYouPetTempStateEnv>,
  cursors: Array<string | undefined>,
) {
  const cycleTailSignals = { count: 0 };
  const proposal = buildYouPetActionRequestProposal({
    routeId: "task-escalate",
    tenantId: TEST_TENANT_ID,
    actorId: PLUGIN_RESTART_ACTOR_ID,
    sourceEventId: "event-plugin-restart",
    sourceOccurredAt: "2026-08-11T01:00:00Z",
    correlationId: "corr-plugin-restart",
    targetId: TEST_TASK_ID,
    payloadFields: {
      task_id: TEST_TASK_ID,
      severity: "medium",
      summary: "Task missed the configured YouPet check-in threshold.",
    },
  });
  const foreignTemplate = actionRequestEnvelopeFromCreate(proposal.request);
  foreignTemplate.action_request.approval = { state: "approved" };
  vi.stubGlobal("fetch", createPluginRestartFetch(cursors, foreignTemplate, cycleTailSignals));
  const registerService = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "youpet",
      name: "YouPet Core",
      source: "test",
      pluginConfig: {
        enabled: true,
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        tenantId: TEST_TENANT_ID,
        pollIntervalMs: 60_000,
      },
      runtime: { state: createYouPetTestRuntimeState(env) } as never,
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
  return { cycleTailSignals, service };
}

function loadPluginRestartCursor(env: ReturnType<typeof createYouPetTempStateEnv>) {
  return createYouPetTestFlowStore(env).actionRequestCursorStore.load(PLUGIN_RESTART_CURSOR_PARAMS);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("youpet plugin registration", () => {
  it("reopens the production cursor wiring and resumes its SQLite frontier", async () => {
    const env = createYouPetTempStateEnv();
    const firstCursors: Array<string | undefined> = [];
    const firstRun = startPluginRestartService(env, firstCursors);
    await waitForCondition(
      () => loadPluginRestartCursor(env) === "cursor-200",
      "the first plugin service to persist cursor-200",
    );
    await waitForCondition(
      () => firstRun.cycleTailSignals.count >= 1,
      "the first plugin service to finish its not_required/not_started tail slice",
    );
    firstRun.service.stop?.();

    resetPluginStateStoreForTests();

    const secondCursors: Array<string | undefined> = [];
    const secondRun = startPluginRestartService(env, secondCursors);
    await waitForCondition(
      () => secondCursors.length >= 2,
      "the restarted plugin approved/not_started cursor request",
    );
    await waitForCondition(
      () => secondRun.cycleTailSignals.count >= 1,
      "the restarted plugin service to finish its not_required/not_started tail slice",
    );
    secondRun.service.stop?.();

    expect(firstCursors[0]).toBeUndefined();
    expect(firstCursors.at(-1)).toBe("cursor-199");
    expect(secondCursors.slice(0, 2)).toEqual([undefined, "cursor-200"]);
  });

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
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(3);
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
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(3);
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
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(3);
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
