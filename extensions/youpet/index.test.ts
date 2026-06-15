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
import { createCoreOutboxEvent } from "./test/outbox-consumer.fixture.js";

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

async function waitForRequestCount(requests: CapturedRequest[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (requests.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} requests`);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("youpet plugin registration", () => {
  it("wires health plan flow creation through the production outbox service path", async () => {
    const env = createYouPetTempStateEnv();
    const runtimeState = createYouPetTestRuntimeState(env);
    const openSyncKeyedStore = vi.fn(runtimeState.openSyncKeyedStore);
    const registerService = vi.fn();
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
    await waitForRequestCount(requests, 2);
    service.stop?.();

    const flowStore = createYouPetTestFlowStore(env).flowStore;
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(2);
    expect(flowStore.lookupFlowByPlanId("plan-1")).toMatchObject({
      plan_id: "plan-1",
      pet_id: "pet-1",
      status: "active",
      correlation_id: "corr-flow",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/events/outbox",
      "/internal/events/outbox/evt-health_plan.activated/ack",
    ]);
    expect(requests.some((request) => new URL(request.url).pathname.startsWith("/api/v1/"))).toBe(
      false,
    );
  });
});
