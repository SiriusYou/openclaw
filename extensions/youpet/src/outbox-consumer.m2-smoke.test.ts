import { randomUUID } from "node:crypto";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
  createYouPetTestRuntimeState,
} from "../test/flow-store.fixture.js";

const OWNER_ID = "00000000-0000-0000-0000-000000000001";

type ConsumerAuthEntry = {
  token: string;
  actor_id: string;
  outbox_lane?: string | null;
};

type ConsumerAuthMap = Record<string, ConsumerAuthEntry>;

type SmokeConfig = {
  coreBaseUrl: string;
  consumerAuth: ConsumerAuthMap & {
    hermes: ConsumerAuthEntry;
    openclaw: ConsumerAuthEntry;
  };
};

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  status?: number;
  ok?: boolean;
};

type CoreOutboxItem = {
  event_id: string;
  event_type: string;
  payload: unknown;
};

type CoreOutboxResponse = {
  items?: unknown[];
};

type CoreHealthPlanResponse = {
  id: string;
  pet_id: string;
  openclaw_flow_id?: string | null;
};

const smokeIt = process.env.YOUPET_M2_FLOW_SMOKE === "1" ? it : it.skip;

afterEach(async () => {
  vi.unstubAllGlobals();
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPet M2 OpenClaw flow live smoke", () => {
  it("fails loudly when the live smoke flag is set without required env", () => {
    expect(() => readSmokeConfig({ YOUPET_M2_FLOW_SMOKE: "1" })).toThrow(/YOUPET_CORE_BASE_URL/);
    expect(() =>
      readSmokeConfig({
        YOUPET_M2_FLOW_SMOKE: "1",
        YOUPET_CORE_BASE_URL: "http://127.0.0.1:18080",
      }),
    ).toThrow(/YOUPET_CONSUMER_AUTH/);
    expect(() =>
      readSmokeConfig({
        YOUPET_M2_FLOW_SMOKE: "1",
        YOUPET_CORE_BASE_URL: "http://127.0.0.1:18080",
        YOUPET_CONSUMER_AUTH: JSON.stringify({
          hermes: {
            token: "hermes-token",
            actor_id: "hermes-wecom-bridge",
            outbox_lane: "openclaw",
          },
          openclaw: {
            token: "openclaw-token",
            actor_id: "openclaw-youpet-consumer",
            outbox_lane: "openclaw",
          },
        }),
      }),
    ).toThrow(/hermes.*outbox_lane/);
  });

  smokeIt("runs the M2 flow adapter against live Core HTTP", async () => {
    const config = readSmokeConfig(process.env);
    if (!config) {
      throw new Error("YOUPET_M2_FLOW_SMOKE=1 is required for this smoke");
    }
    const runId = randomUUID();
    const originalFetch = globalThis.fetch.bind(globalThis);

    const pet = await requestJson<{ id: string }>(
      config,
      config.consumerAuth.hermes,
      "/api/v1/pets",
      {
        method: "POST",
        body: {
          owner_user_id: OWNER_ID,
          name: `M2 Smoke Cat ${runId.slice(0, 8)}`,
          species: "cat",
          breed: "Exotic Shorthair",
          weight_kg: 3.8,
        },
        idempotencyKey: `${runId}:pet`,
        fetchFn: originalFetch,
      },
    );

    const plan = await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.hermes,
      "/api/v1/health-plans",
      {
        method: "POST",
        body: {
          pet_id: pet.id,
          plan_type: "deworming",
          title: `M2 smoke deworming ${runId.slice(0, 8)}`,
          start_at: new Date(Date.now() + 60_000).toISOString(),
          schedule_rule: "FREQ=DAILY;INTERVAL=1",
          reminder_times: ["09:00"],
          missed_threshold: 2,
        },
        idempotencyKey: `${runId}:plan`,
        fetchFn: originalFetch,
      },
    );

    await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.hermes,
      `/api/v1/health-plans/${encodeURIComponent(plan.id)}/activate`,
      {
        method: "POST",
        idempotencyKey: `${runId}:activate`,
        correlationId: `m2-smoke-${runId}`,
        fetchFn: originalFetch,
      },
    );

    const hermesPull = await pullHermesDeliveries(
      config,
      config.consumerAuth.hermes,
      plan.id,
      originalFetch,
    );
    await Promise.all(
      hermesPull.claimedEventIds.map((eventId) =>
        requestJson<unknown>(
          config,
          config.consumerAuth.hermes,
          `/internal/events/outbox/${encodeURIComponent(eventId)}/ack`,
          {
            method: "POST",
            query: { consumer: "hermes" },
            idempotencyKey: `${runId}:ack-hermes:${eventId}`,
            fetchFn: originalFetch,
          },
        ),
      ),
    );

    const env = createYouPetTempStateEnv();
    const runtimeState = createYouPetTestRuntimeState(env);
    const openSyncKeyedStore = vi.fn(runtimeState.openSyncKeyedStore);
    const registerService = vi.fn();
    const recordedRequests: RecordedRequest[] = [];
    const serviceLogProbe = createServiceLogProbe();
    vi.stubGlobal(
      "fetch",
      createRecordingFetch(config.coreBaseUrl, originalFetch, recordedRequests),
    );

    plugin.register(
      createTestPluginApi({
        id: "youpet",
        name: "YouPet Core",
        source: "test",
        pluginConfig: {
          enabled: true,
          coreBaseUrl: config.coreBaseUrl,
          serviceToken: config.consumerAuth.openclaw.token,
          actorId: config.consumerAuth.openclaw.actor_id,
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

    const flowStore = createYouPetTestFlowStore(env).flowStore;
    try {
      service.start({
        logger: serviceLogProbe.logger,
        stateDir: "",
        config: {},
      });
      await waitFor(
        () =>
          flowStore.lookupFlowByPlanId(plan.id)?.core_linked === true &&
          successfulAckRequests(recordedRequests).length === 1,
      );
    } finally {
      service.stop?.();
    }

    const activatedFlow = flowStore.lookupFlowByPlanId(plan.id);
    expect(activatedFlow).toMatchObject({
      plan_id: plan.id,
      pet_id: pet.id,
      core_linked: true,
      checkin_count: 0,
    });
    expect(activatedFlow?.flow_id).toBeTypeOf("string");
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(2);
    expect(nackRequests(recordedRequests)).toHaveLength(0);
    expect(failedAckRequests(recordedRequests)).toHaveLength(0);
    expect(successfulAckRequests(recordedRequests)).toHaveLength(1);
    expect(serviceLogProbe.problems).toEqual([]);

    const activationFlowPosts = flowWritebackRequests(recordedRequests, plan.id);
    expect(activationFlowPosts).toHaveLength(1);
    expect(activationFlowPosts[0]).toMatchObject({
      method: "POST",
      body: { openclaw_flow_id: activatedFlow?.flow_id },
    });

    const replay = await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.openclaw,
      `/api/v1/health-plans/${encodeURIComponent(plan.id)}/flow`,
      {
        method: "POST",
        body: { openclaw_flow_id: activatedFlow?.flow_id },
        idempotencyKey: `${runId}:flow-replay`,
        fetchFn: originalFetch,
      },
    );
    expect(replay.openclaw_flow_id).toBe(activatedFlow?.flow_id);

    await requestJson<unknown>(
      config,
      config.consumerAuth.hermes,
      `/api/v1/tasks/${encodeURIComponent(hermesPull.taskId)}/checkin`,
      {
        method: "POST",
        body: {
          submitted_by: OWNER_ID,
          text: "M2 smoke check-in completed. Looks normal.",
          status_tags: ["completed", "normal"],
          media_asset_ids: [],
        },
        idempotencyKey: `${runId}:checkin`,
        correlationId: `m2-smoke-checkin-${runId}`,
        fetchFn: originalFetch,
      },
    );

    const flowWritebacksBeforeCheckin = flowWritebackRequests(recordedRequests, plan.id).length;
    try {
      service.start({
        logger: serviceLogProbe.logger,
        stateDir: "",
        config: {},
      });
      await waitFor(
        () =>
          flowStore.lookupFlowByPlanId(plan.id)?.checkin_count === 1 &&
          successfulAckRequests(recordedRequests).length === 2,
      );
    } finally {
      service.stop?.();
    }

    const checkedInFlow = flowStore.lookupFlowByPlanId(plan.id);
    expect(checkedInFlow).toMatchObject({
      flow_id: activatedFlow?.flow_id,
      plan_id: plan.id,
      pet_id: pet.id,
      core_linked: true,
      checkin_count: 1,
    });
    expect(flowWritebackRequests(recordedRequests, plan.id)).toHaveLength(
      flowWritebacksBeforeCheckin,
    );
    expect(nackRequests(recordedRequests)).toHaveLength(0);
    expect(failedAckRequests(recordedRequests)).toHaveLength(0);
    expect(successfulAckRequests(recordedRequests)).toHaveLength(2);
    expect(serviceLogProbe.problems).toEqual([]);
  });
});

function readSmokeConfig(env: Record<string, string | undefined>): SmokeConfig | null {
  if (env.YOUPET_M2_FLOW_SMOKE !== "1") {
    return null;
  }
  const coreBaseUrl = readRequiredEnv(env, "YOUPET_CORE_BASE_URL").replace(/\/+$/u, "");
  const consumerAuth = parseConsumerAuth(readRequiredEnv(env, "YOUPET_CONSUMER_AUTH"));
  return { coreBaseUrl, consumerAuth };
}

function readRequiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required when YOUPET_M2_FLOW_SMOKE=1`);
  }
  return value;
}

function parseConsumerAuth(raw: string): SmokeConfig["consumerAuth"] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("YOUPET_CONSUMER_AUTH must be a JSON object");
  }
  const hermes = readConsumerAuthEntry(parsed, "hermes", "hermes");
  const openclaw = readConsumerAuthEntry(parsed, "openclaw", "openclaw");
  return { ...parsed, hermes, openclaw } as SmokeConfig["consumerAuth"];
}

function readConsumerAuthEntry(
  auth: Record<string, unknown>,
  consumer: string,
  expectedOutboxLane: string,
): ConsumerAuthEntry {
  const entry = auth[consumer];
  if (!isRecord(entry)) {
    throw new Error(`YOUPET_CONSUMER_AUTH must include ${consumer}`);
  }
  const token = readString(entry.token);
  const actorId = readString(entry.actor_id);
  if (!token || !actorId) {
    throw new Error(`YOUPET_CONSUMER_AUTH.${consumer} must include token and actor_id`);
  }
  const outboxLane = readString(entry.outbox_lane);
  if (outboxLane !== expectedOutboxLane) {
    throw new Error(`YOUPET_CONSUMER_AUTH.${consumer}.outbox_lane must be ${expectedOutboxLane}`);
  }
  return {
    token,
    actor_id: actorId,
    outbox_lane: outboxLane,
  };
}

async function requestJson<T>(
  config: SmokeConfig,
  auth: ConsumerAuthEntry,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    idempotencyKey?: string;
    correlationId?: string;
    fetchFn?: typeof fetch;
  } = {},
): Promise<T> {
  const url = new URL(path, `${config.coreBaseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers({
    Authorization: `Bearer ${auth.token}`,
    "X-Actor-Id": auth.actor_id,
  });
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.correlationId) {
    headers.set("X-Correlation-Id", options.correlationId);
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  const response = await (options.fetchFn ?? fetch)(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Core request failed ${response.status} ${url.pathname}: ${text}`);
  }
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

async function pullHermesDeliveries(
  config: SmokeConfig,
  auth: ConsumerAuthEntry,
  planId: string,
  fetchFn: typeof fetch,
): Promise<{ claimedEventIds: string[]; taskId: string }> {
  const outbox = await requestJson<CoreOutboxResponse>(config, auth, "/internal/events/outbox", {
    query: { consumer: "hermes", limit: "50" },
    fetchFn,
  });
  const items = (outbox.items ?? []).filter(isCoreOutboxItem);
  const taskCreated = items.find((item) => {
    const payload = readBusinessPayload(item);
    return (
      item.event_type === "task.created" &&
      readString(payload?.plan_id) === planId &&
      !!readString(payload?.task_id)
    );
  });
  if (!taskCreated) {
    throw new Error(`expected task.created delivery for plan ${planId}`);
  }
  const taskId = readString(readBusinessPayload(taskCreated)?.task_id);
  if (!taskId) {
    throw new Error("task.created delivery did not include payload.payload.task_id");
  }
  return { claimedEventIds: items.map((item) => item.event_id), taskId };
}

function createRecordingFetch(
  coreBaseUrl: string,
  fetchFn: typeof fetch,
  recordedRequests: RecordedRequest[],
): typeof fetch {
  const coreOrigin = new URL(coreBaseUrl).origin;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    if (parsed.origin === coreOrigin) {
      const recorded: RecordedRequest = {
        url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body:
          typeof init?.body === "string" && init.body.length > 0
            ? JSON.parse(init.body)
            : undefined,
      };
      recordedRequests.push(recorded);
      const response = await fetchFn(input, init);
      recorded.status = response.status;
      recorded.ok = response.ok;
      return response;
    }
    return await fetchFn(input, init);
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for M2 smoke condition");
}

function flowWritebackRequests(requests: RecordedRequest[], planId: string): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url).pathname === `/api/v1/health-plans/${planId}/flow` &&
      request.method === "POST",
  );
}

function ackRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => new URL(request.url).pathname.endsWith("/ack"));
}

function successfulAckRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return ackRequests(requests).filter((request) => request.ok === true);
}

function failedAckRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return ackRequests(requests).filter((request) => request.ok === false);
}

function nackRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => new URL(request.url).pathname.endsWith("/nack"));
}

function createServiceLogProbe(): {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  problems: string[];
} {
  const problems: string[] = [];
  return {
    logger: {
      info: vi.fn(),
      warn: (...args: unknown[]) => {
        const message = formatLogArgs(args);
        problems.push(`warn: ${message}`);
        console.warn(...args);
      },
      error: (...args: unknown[]) => {
        const message = formatLogArgs(args);
        problems.push(`error: ${message}`);
        console.error(...args);
      },
    },
    problems,
  };
}

function formatLogArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
}

function isCoreOutboxItem(value: unknown): value is CoreOutboxItem {
  return (
    isRecord(value) &&
    typeof value.event_id === "string" &&
    typeof value.event_type === "string" &&
    "payload" in value
  );
}

function readBusinessPayload(item: CoreOutboxItem): Record<string, unknown> | undefined {
  if (!isRecord(item.payload) || !isRecord(item.payload.payload)) {
    return undefined;
  }
  return item.payload.payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
