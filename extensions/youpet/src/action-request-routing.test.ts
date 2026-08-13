import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTestFlowStore,
  createYouPetTempStateEnv,
} from "../test/flow-store.fixture.js";
import {
  createYouPetActionRequestCursorStore,
  toYouPetActionRequestCursorKey,
  YouPetActionRequestCursorStoreError,
  YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
  YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE,
  type YouPetActionRequestCursorStore,
} from "./action-request-cursor-store.js";
import {
  buildYouPetActionRequestProposal,
  matchActionRequestRoute,
  stableYouPetMutationKey,
  YouPetActionRequestClient,
  YouPetActionRequestCoreError,
  YouPetActionRequestDispatcher,
  YouPetActionRequestTransportError,
  YOUPET_ACTION_REQUEST_ROUTES,
  type YouPetActionRequestEnvelope,
  type YouPetActionRequestExecutionUpdate,
} from "./action-request-routing.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";
const TASK_ID = "00000000-0000-4000-8000-000000000201";
const PLAN_ID = "00000000-0000-4000-8000-000000000301";
const REQUEST_ID = "00000000-0000-4000-8000-000000000401";
const ACTOR_ID = "openclaw-youpet-consumer";
const REACHABLE_CURSOR_SLICES = [
  { approvalState: "approved", executionState: "running" },
  { approvalState: "approved", executionState: "queued" },
  { approvalState: "approved", executionState: "not_started" },
  { approvalState: "not_required", executionState: "running" },
  { approvalState: "not_required", executionState: "queued" },
  { approvalState: "not_required", executionState: "not_started" },
] as const;

type CursorSliceKey = `${"approved" | "not_required"}:${"running" | "queued" | "not_started"}`;
type CursorFaultOperation = "load" | "save" | "clear";
type CursorListPage = { items: YouPetActionRequestEnvelope[]; nextCursor: string | null };

afterEach(async () => {
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPet ActionRequest proposal routing", () => {
  it("builds one deterministic high-risk approval proposal for task escalation", () => {
    const first = buildYouPetActionRequestProposal({
      routeId: "task-escalate",
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sourceEventId: "evt-task-missed-1",
      sourceOccurredAt: "2026-08-09T01:02:03Z",
      correlationId: "corr-task-1",
      targetId: TASK_ID,
      payloadFields: {
        task_id: TASK_ID,
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
    });
    const replay = buildYouPetActionRequestProposal({
      routeId: "task-escalate",
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sourceEventId: "evt-task-missed-1",
      sourceOccurredAt: "2026-08-09T01:02:03Z",
      correlationId: "corr-task-1",
      targetId: TASK_ID,
      payloadFields: {
        task_id: TASK_ID,
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
    });

    expect(replay).toEqual(first);
    expect(first.request).toMatchObject({
      tenant_id: TENANT_ID,
      proposer: { type: "agent", id: ACTOR_ID },
      target: { type: "task_instance", id: TASK_ID },
      action_type: "task.escalate",
      risk: "high",
      payload: { mode: "inline", fields: { task_id: TASK_ID } },
      policy: {
        outcome: "require_approval",
        required_approver_class: "operator",
        policy_id: "openclaw.youpet.task-missed",
        decided_at: "2026-08-09T01:02:03.000Z",
      },
      links: {
        domain_event_ids: ["evt-task-missed-1"],
        proposal_event_id: "evt-task-missed-1",
      },
      correlation_id: "corr-task-1",
    });
    expect(first.request.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.request.policy.decision_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.idempotencyKey).toMatch(/^openclaw\.youpet\.proposal\.[0-9a-f]{64}$/u);
  });

  it("locks health-plan flow linking to an explicit allow policy", () => {
    const proposal = buildYouPetActionRequestProposal({
      routeId: "health-plan-flow-link",
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sourceEventId: "evt-plan-activated-1",
      sourceOccurredAt: "2026-08-09T02:00:00Z",
      targetId: PLAN_ID,
      payloadFields: {
        health_plan_id: PLAN_ID,
        openclaw_flow_id: "flow-1",
      },
    });

    expect(YOUPET_ACTION_REQUEST_ROUTES["health-plan-flow-link"]).toMatchObject({
      actionType: "workflow.mutate",
      targetType: "health_plan",
      risk: "low",
      policyOutcome: "allow",
    });
    expect(proposal.request).toMatchObject({
      target: { type: "health_plan", id: PLAN_ID },
      action_type: "workflow.mutate",
      risk: "low",
      payload: {
        mode: "inline",
        fields: { health_plan_id: PLAN_ID, openclaw_flow_id: "flow-1" },
      },
      policy: { outcome: "allow", obligations: [] },
    });
    expect(proposal.request.policy).not.toHaveProperty("required_approver_class");
  });

  it("scopes deterministic proposal identity and idempotency to the tenant", () => {
    const build = (tenantId: string) =>
      buildYouPetActionRequestProposal({
        routeId: "task-escalate",
        tenantId,
        actorId: ACTOR_ID,
        sourceEventId: "shared-event-id",
        sourceOccurredAt: "2026-08-09T01:02:03Z",
        targetId: TASK_ID,
        payloadFields: {
          task_id: TASK_ID,
          severity: "medium",
          summary: "Task missed the configured YouPet check-in threshold.",
        },
      });

    const first = build(TENANT_ID);
    const second = build("00000000-0000-4000-8000-000000000102");

    expect(second.request.id).not.toBe(first.request.id);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("fails closed before proposal for invalid tenant, target, or correlation identity", () => {
    const base = {
      routeId: "task-escalate" as const,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sourceEventId: "evt-task-missed-1",
      sourceOccurredAt: "2026-08-09T01:02:03Z",
      correlationId: "corr-task-1",
      targetId: TASK_ID,
      payloadFields: {
        task_id: TASK_ID,
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
    };

    expect(() => buildYouPetActionRequestProposal({ ...base, tenantId: "shared" })).toThrow(
      /tenant_id must be a UUID/u,
    );
    expect(() => buildYouPetActionRequestProposal({ ...base, targetId: "task-1" })).toThrow(
      /target.id must be a UUID/u,
    );
    expect(() =>
      buildYouPetActionRequestProposal({ ...base, correlationId: "sk-abcdefgh1234" }),
    ).toThrow(/secret-safe opaque/u);
  });
});

describe("YouPet ActionRequest client boundary", () => {
  it("uses only create, get, list, execution-claim, and execution-status Core paths", async () => {
    const captured: Array<{ path: string; method: string; headers: Headers; body: unknown }> = [];
    const envelope = createEnvelope();
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      captured.push({
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return jsonResponse(
        url.pathname === "/api/v1/action-requests" && !url.search
          ? envelope
          : url.pathname === "/api/v1/action-requests"
            ? url.searchParams.get("cursor") === "cursor-page-2"
              ? { items: [envelope], count: 1, next_cursor: null }
              : { items: [envelope], count: 1, next_cursor: "cursor-page-2" }
            : envelope,
      );
    });
    const client = new YouPetActionRequestClient({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      actorId: ACTOR_ID,
      fetchFn,
    });
    const proposal = buildYouPetActionRequestProposal({
      routeId: "task-escalate",
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      sourceEventId: "evt-task-missed-1",
      sourceOccurredAt: "2026-08-09T01:02:03Z",
      targetId: TASK_ID,
      payloadFields: {
        task_id: TASK_ID,
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
    });

    await client.create(proposal);
    await client.get(REQUEST_ID);
    await client.list({
      tenantId: TENANT_ID,
      approvalState: "approved",
      executionState: "not_started",
    });
    await client.list({
      tenantId: TENANT_ID,
      approvalState: "approved",
      executionState: "not_started",
      cursor: "cursor-page-2",
    });
    await client.updateExecution({
      actionRequestId: REQUEST_ID,
      update: { state: "queued", expected_row_version: 1 },
      idempotencyKey: "execution-key",
    });
    await client.claimExecution({
      actionRequestId: REQUEST_ID,
      claim: { worker_id: "worker-a", expected_row_version: 2 },
      idempotencyKey: "claim-key",
    });
    await client.updateExecution({
      actionRequestId: REQUEST_ID,
      update: { state: "succeeded", expected_row_version: 3, worker_id: "worker-a" },
      idempotencyKey: "terminal-key",
    });

    expect(captured.map((entry) => entry.path)).toEqual([
      "/api/v1/action-requests",
      `/api/v1/action-requests/${REQUEST_ID}`,
      "/api/v1/action-requests?tenant_id=00000000-0000-4000-8000-000000000101&approval_state=approved&execution_state=not_started&limit=200",
      "/api/v1/action-requests?tenant_id=00000000-0000-4000-8000-000000000101&approval_state=approved&execution_state=not_started&limit=200&cursor=cursor-page-2",
      `/api/v1/action-requests/${REQUEST_ID}/execution-status`,
      `/api/v1/action-requests/${REQUEST_ID}/execution-claim`,
      `/api/v1/action-requests/${REQUEST_ID}/execution-status`,
    ]);
    expect(captured.some((entry) => /\/(approve|reject)$/u.test(entry.path))).toBe(false);
    expect(captured[0]?.headers.get("idempotency-key")).toBe(proposal.idempotencyKey);
    expect(captured[4]?.body).toEqual({ state: "queued", expected_row_version: 1 });
    expect(captured[5]?.body).toEqual({ worker_id: "worker-a", expected_row_version: 2 });
    expect(captured[6]?.body).toEqual({
      state: "succeeded",
      expected_row_version: 3,
      worker_id: "worker-a",
    });
  });

  it("fails loudly when Core omits required execution_claim from the envelope", async () => {
    const malformed = createEnvelope();
    const fetchFn = vi.fn(async () => {
      const body = structuredClone(malformed) as Record<string, unknown>;
      delete body.execution_claim;
      return jsonResponse(body);
    });
    const client = new YouPetActionRequestClient({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      actorId: ACTOR_ID,
      fetchFn,
    });

    await expect(client.get(REQUEST_ID)).rejects.toThrow(/execution_claim must be an object/u);
  });

  it("wraps fetch-failed and ECONNRESET as YouPetActionRequestTransportError", async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    });
    const client = new YouPetActionRequestClient({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      actorId: ACTOR_ID,
      fetchFn,
    });

    await expect(
      client.list({
        tenantId: TENANT_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).rejects.toBeInstanceOf(YouPetActionRequestTransportError);
  });

  it("wraps UND_ERR_CONNECT_TIMEOUT fetch failures as YouPetActionRequestTransportError", async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new Error("Connect Timeout Error"), {
        name: "ConnectTimeoutError",
        code: "UND_ERR_CONNECT_TIMEOUT",
      });
    });
    const client = new YouPetActionRequestClient({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      actorId: ACTOR_ID,
      fetchFn,
    });

    await expect(
      client.list({
        tenantId: TENANT_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).rejects.toMatchObject({
      name: "YouPetActionRequestTransportError",
      path: "/api/v1/action-requests",
    });
  });

  it("does not wrap a programming TypeError as transport", async () => {
    const error = await rejectClientList(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'ok')");
    });
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(YouPetActionRequestTransportError);
    expect(error).toMatchObject({
      message: "Cannot read properties of undefined (reading 'ok')",
    });
  });

  it("wraps a body-stream UND_ERR_SOCKET as YouPetActionRequestTransportError", async () => {
    await expect(
      rejectClientList(async () =>
        failingBodyResponse(Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" })),
      ),
    ).resolves.toBeInstanceOf(YouPetActionRequestTransportError);
  });

  it("does not wrap caller AbortError as transport", async () => {
    const error = await rejectClientList(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    expect(error).toBeInstanceOf(DOMException);
    expect(error).not.toBeInstanceOf(YouPetActionRequestTransportError);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it("does not wrap a message-only fetch-failed programming error as transport", async () => {
    const error = await rejectClientList(async () => {
      throw new Error("fetch failed while building request headers");
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(YouPetActionRequestTransportError);
    expect(error).toMatchObject({
      message: "fetch failed while building request headers",
    });
  });

  it("does not wrap a bare TypeError fetch failed without a transport cause", async () => {
    const error = await rejectClientList(async () => {
      throw new TypeError("fetch failed");
    });
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(YouPetActionRequestTransportError);
  });

  it.each([
    {
      name: "structured UND_ERR_INVALID_ARG",
      fetchFn: async () => {
        throw Object.assign(new TypeError("invalid argument"), { code: "UND_ERR_INVALID_ARG" });
      },
      expected: { name: "TypeError" },
    },
    {
      name: "message-only UND_ERR_INVALID_ARG",
      fetchFn: async () => {
        throw new Error("Request failed with UND_ERR_INVALID_ARG");
      },
      expected: { message: "Request failed with UND_ERR_INVALID_ARG" },
    },
  ])("does not wrap $name as transport", async ({ fetchFn, expected }) => {
    const error = await rejectClientList(fetchFn);
    expect(error).not.toBeInstanceOf(YouPetActionRequestTransportError);
    expect(error).toMatchObject(expected);
  });
});

describe("YouPet ActionRequest cursor store", () => {
  it("loads all six reachable tenant and actor slices within the 32-entry namespace budget", () => {
    vi.useFakeTimers();
    const env = createYouPetTempStateEnv();
    const rawStore = createPluginStateSyncKeyedStoreForTests("youpet", {
      namespace: YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE,
      maxEntries: YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
      env,
    });
    const cursorStore = createYouPetActionRequestCursorStore(rawStore);
    try {
      expect(YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES).toBe(32);
      expect(REACHABLE_CURSOR_SLICES).toHaveLength(6);
      expect(REACHABLE_CURSOR_SLICES.length).toBeLessThan(
        YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
      );

      const fillerEntries = Array.from(
        { length: YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES - REACHABLE_CURSOR_SLICES.length },
        (_, index) => ({
          tenantId: nthUuid(80_000 + index),
          actorId: `cursor-filler-${index + 1}`,
          approvalState: "approved" as const,
          executionState: "not_started" as const,
          nextCursor: `filler-cursor-${index + 1}`,
        }),
      );
      const oldestFiller = fillerEntries[0];
      if (!oldestFiller) {
        throw new Error("expected at least one filler cursor-store entry");
      }
      const overflowEntry = {
        tenantId: nthUuid(90_000),
        actorId: "cursor-filler-overflow",
        approvalState: "not_required" as const,
        executionState: "queued" as const,
        nextCursor: "filler-cursor-overflow",
      };

      fillerEntries.forEach((entry, index) => {
        vi.setSystemTime(1_000 + index);
        cursorStore.save(entry);
      });
      REACHABLE_CURSOR_SLICES.forEach((slice, index) => {
        vi.setSystemTime(2_000 + index);
        cursorStore.save({
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          approvalState: slice.approvalState,
          executionState: slice.executionState,
          nextCursor: `cursor-${index + 1}`,
        });
      });
      vi.setSystemTime(3_000);
      cursorStore.save(overflowEntry);

      expect(rawStore.entries()).toHaveLength(YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES);
      expect(
        rawStore
          .entries()
          .map((entry) => entry.key)
          .includes(toYouPetActionRequestCursorKey(overflowEntry)),
      ).toBe(true);
      expect(cursorStore.load(oldestFiller)).toBeUndefined();
      expect(cursorStore.load(overflowEntry)).toBe("filler-cursor-overflow");
      expect(
        REACHABLE_CURSOR_SLICES.map((slice) =>
          cursorStore.load({
            tenantId: TENANT_ID,
            actorId: ACTOR_ID,
            approvalState: slice.approvalState,
            executionState: slice.executionState,
          }),
        ),
      ).toEqual(["cursor-1", "cursor-2", "cursor-3", "cursor-4", "cursor-5", "cursor-6"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["load", "save", "clear"] as const)(
    "wraps %s faults with an explicit cursor-store error",
    (operation) => {
      expectCursorStoreFault(operation);
    },
  );
});

describe("YouPet ActionRequest dispatcher", () => {
  it("claims with CAS, executes once, and records terminal success", async () => {
    const core = new FakeActionRequestCore(createEnvelope());
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated", retryable: false },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: core,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, conflicted: 0 });
    expect(core.updates.map((entry) => entry.update.state)).toEqual(["queued", "succeeded"]);
    expect(core.claims.map((entry) => entry.claim.expected_row_version)).toEqual([2]);
    expect(core.updates.map((entry) => entry.update.expected_row_version)).toEqual([1, 3]);
    expect(core.updates[1]?.update.worker_id).toBe("worker-a");
    expect(executeMutation).toHaveBeenCalledOnce();
    expect(executeMutation.mock.calls[0]?.[0].idempotencyKey).toBe(
      stableYouPetMutationKey(REQUEST_ID, "task-escalate"),
    );
  });

  it("paginates past 200 newer unmatched rows and still executes an older valid request", async () => {
    const valid = createEnvelope({ requestId: nthUuid(901) });
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      createEnvelope({
        requestId: nthUuid(index + 1),
        proposerId: `foreign-agent-${index + 1}`,
      }),
    );
    const core = new FakeActionRequestCore(valid, {
      listPages: {
        "approved:not_started": [firstPage, [valid]],
      },
    });
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: core,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      listed: 201,
      skipped: 200,
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
    });
    expect(core.listRequests).toEqual([
      { approvalState: "approved", executionState: "running", cursor: undefined },
      { approvalState: "not_required", executionState: "running", cursor: undefined },
      { approvalState: "approved", executionState: "queued", cursor: undefined },
      { approvalState: "not_required", executionState: "queued", cursor: undefined },
      { approvalState: "approved", executionState: "not_started", cursor: undefined },
      {
        approvalState: "approved",
        executionState: "not_started",
        cursor: "approved:not_started:1",
      },
      { approvalState: "not_required", executionState: "not_started", cursor: undefined },
    ]);
    expect(executeMutation).toHaveBeenCalledOnce();
  });

  it("streams page-bounded backlog scans across multiple dispatch cycles without starving the later valid request", async () => {
    const foreignPageCount = 10_005;
    const valid = createEnvelope({ requestId: nthUuid(20_100) });
    const core = new FakeActionRequestCore(valid);
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const env = createYouPetTempStateEnv();
    const { actionRequestCursorStore } = createYouPetTestFlowStore(env);
    const client = {
      async list(params: { approvalState: string; executionState: string; cursor?: string }) {
        if (params.approvalState !== "approved" || params.executionState !== "not_started") {
          return { items: [], nextCursor: null };
        }
        const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
        if (pageIndex < foreignPageCount) {
          return {
            items: [
              createEnvelope({
                requestId: nthUuid(pageIndex + 1),
                proposerId: `foreign-agent-${pageIndex + 1}`,
              }),
            ],
            nextCursor: `cursor-${pageIndex + 1}`,
          };
        }
        return { items: [structuredClone(valid)], nextCursor: null };
      },
      async get(actionRequestId: string) {
        return await core.get(actionRequestId);
      },
      async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
        return await core.claimExecution(params);
      },
      async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
        return await core.updateExecution(params);
      },
    };

    let aggregate = {
      listed: 0,
      skipped: 0,
      claimed: 0,
      succeeded: 0,
      conflicted: 0,
      errored: 0,
      failed: 0,
      retried: 0,
    };
    for (let cycle = 0; cycle < 60; cycle += 1) {
      const dispatcher = new YouPetActionRequestDispatcher({
        client,
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        workerId: "worker-a",
        executeMutation,
        cursorStore: actionRequestCursorStore,
      });
      const result = await dispatcher.dispatchOnce();
      aggregate = {
        listed: aggregate.listed + result.listed,
        skipped: aggregate.skipped + result.skipped,
        claimed: aggregate.claimed + result.claimed,
        succeeded: aggregate.succeeded + result.succeeded,
        conflicted: aggregate.conflicted + result.conflicted,
        errored: aggregate.errored + result.errored,
        failed: aggregate.failed + result.failed,
        retried: aggregate.retried + result.retried,
      };
      if (result.succeeded === 1) {
        break;
      }
    }

    expect(aggregate).toMatchObject({
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
      errored: 0,
    });
    expect(aggregate.listed).toBeGreaterThan(foreignPageCount);
    expect(aggregate.skipped).toBe(aggregate.listed - 1);
    expect(executeMutation).toHaveBeenCalledOnce();
  });

  it("fails the cycle when Core repeats next_cursor during pagination", async () => {
    const client = {
      async list() {
        return { items: [], nextCursor: "stuck-cursor" };
      },
      async get() {
        return createEnvelope();
      },
      async claimExecution() {
        return createEnvelope();
      },
      async updateExecution() {
        return createEnvelope();
      },
    };
    const dispatcher = new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "retry" }),
    });

    await expect(dispatcher.dispatchOnce()).rejects.toThrow(/repeated next_cursor/u);
  });

  it("dispatches a newly arrived head request before continuing an older saved backlog", async () => {
    const fresh = createEnvelope({ requestId: nthUuid(40_000) });
    const freshCore = new FakeActionRequestCore(fresh);
    let exposeFreshHead = false;
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState !== "approved" || params.executionState !== "not_started") {
            return { items: [], nextCursor: null };
          }
          if (!params.cursor && exposeFreshHead) {
            return { items: [structuredClone(fresh)], nextCursor: "cursor-1" };
          }
          const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
          if (pageIndex < 250) {
            return {
              items: [
                createEnvelope({
                  requestId: nthUuid(40_100 + pageIndex),
                  proposerId: `foreign-agent-${pageIndex}`,
                }),
              ],
              nextCursor: `cursor-${pageIndex + 1}`,
            };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          return await freshCore.get(actionRequestId);
        },
        async claimExecution(params) {
          return await freshCore.claimExecution(params);
        },
        async updateExecution(params) {
          return await freshCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "succeeded" as const, result: { outcome_code: "ok" } }),
    });

    const first = await dispatcher.dispatchOnce();
    exposeFreshHead = true;
    const second = await dispatcher.dispatchOnce();

    expect(first.succeeded).toBe(0);
    expect(second.succeeded).toBe(1);
  });

  it("checkpoints each completed backlog page before a later list failure", async () => {
    const valid = createEnvelope({ requestId: nthUuid(41_000) });
    const validCore = new FakeActionRequestCore(valid);
    let failCursorTwo = true;
    const targetRequests: Array<string | undefined> = [];
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState !== "approved" || params.executionState !== "not_started") {
            return { items: [], nextCursor: null };
          }
          targetRequests.push(params.cursor);
          if (!params.cursor) {
            return {
              items: [
                createEnvelope({ requestId: nthUuid(41_100), proposerId: "foreign-agent-head" }),
              ],
              nextCursor: "cursor-1",
            };
          }
          if (params.cursor === "cursor-1") {
            return {
              items: [
                createEnvelope({ requestId: nthUuid(41_101), proposerId: "foreign-agent-one" }),
              ],
              nextCursor: "cursor-2",
            };
          }
          if (failCursorTwo) {
            failCursorTwo = false;
            throw new Error("transient list failure");
          }
          return { items: [structuredClone(valid)], nextCursor: null };
        },
        async get(actionRequestId) {
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "succeeded" as const, result: { outcome_code: "ok" } }),
    });

    await expect(dispatcher.dispatchOnce()).rejects.toThrow("transient list failure");
    const requestsBeforeRetry = targetRequests.length;
    const retried = await dispatcher.dispatchOnce();

    expect(targetRequests.slice(requestsBeforeRetry)).toEqual([undefined, "cursor-2", "cursor-2"]);
    expect(retried.succeeded).toBe(1);
  });

  it("fails bounded pagination when unique cursors repeat the same candidate frontier", async () => {
    const duplicate = createEnvelope({
      requestId: nthUuid(42_000),
      proposerId: "foreign-agent-duplicate",
    });
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState !== "approved" || params.executionState !== "not_started") {
            return { items: [], nextCursor: null };
          }
          const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
          return {
            items: [structuredClone(duplicate)],
            nextCursor: `cursor-${pageIndex + 1}`,
          };
        },
        async get() {
          return createEnvelope();
        },
        async claimExecution() {
          return createEnvelope();
        },
        async updateExecution() {
          return createEnvelope();
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "retry" }),
    });

    await expect(dispatcher.dispatchOnce()).rejects.toThrow(/pagination no-progress guard/u);
  });

  it.each([
    {
      operation: "load",
      requestId: 42_100,
      page: { items: [], nextCursor: null },
      message: "cursor load failed",
    },
    {
      operation: "save",
      requestId: 42_101,
      page: { items: [], nextCursor: "cursor-1" },
      message: "cursor save failed",
    },
    {
      operation: "clear",
      requestId: 42_102,
      page: { items: [], nextCursor: null },
      message: "cursor clear failed",
    },
  ] as const)(
    "isolates a cursor-store $operation failure to that slice and continues later slices",
    async ({ operation, requestId, page, message }) => {
      const { result, validCore, logger } = await runCursorSliceIsolationCase({
        operation,
        requestId,
        page,
      });

      expect(result).toMatchObject({ errored: 1, claimed: 1, succeeded: 1 });
      expect(validCore.claims).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`ActionRequest cursor slice approved/queued failed: ${message}`),
      );
    },
  );

  it("does not claim durable backlog progress when cursor save fails before restart", async () => {
    const env = createYouPetTempStateEnv();
    const valid = createEnvelope({ requestId: nthUuid(42_103) });
    const validCore = new FakeActionRequestCore(valid);
    const firstRequests: Array<string | undefined> = [];
    const first = await dispatchDeepBacklogOnce({
      validCore,
      valid,
      requests: firstRequests,
      cursorStore: createFaultingCursorStore(
        { save: ["approved:not_started"] },
        { delegate: createTestCursorStore(env), once: true },
      ),
    });

    expect(first).toMatchObject({ errored: 1, claimed: 0, succeeded: 0 });
    expect(firstRequests).toEqual([undefined]);

    resetPluginStateStoreForTests();

    const secondRequests: Array<string | undefined> = [];
    const second = await dispatchDeepBacklogOnce({
      validCore,
      valid,
      requests: secondRequests,
      cursorStore: createTestCursorStore(env),
    });

    expect(second).toMatchObject({ succeeded: 0, errored: 0 });
    expect(secondRequests[0]).toBeUndefined();

    resetPluginStateStoreForTests();

    const thirdRequests: Array<string | undefined> = [];
    const third = await dispatchDeepBacklogOnce({
      validCore,
      valid,
      requests: thirdRequests,
      cursorStore: createTestCursorStore(env),
    });

    expect(third).toMatchObject({ claimed: 1, succeeded: 1, errored: 0 });
    expect(thirdRequests).toEqual([undefined, "cursor-200", "cursor-200"]);
  });

  it("reconciles a stale completed frontier after clear failure and still drains later backlog", async () => {
    const env = createYouPetTempStateEnv();
    const executed = new Set<string>();
    const executeMutation = vi.fn(async (params: { envelope: YouPetActionRequestEnvelope }) => {
      const id = params.envelope.action_request.id;
      if (executed.has(id)) {
        throw new Error(`duplicate mutation for ${id}`);
      }
      executed.add(id);
      return { kind: "succeeded" as const, result: { outcome_code: "ok" } };
    });
    const initial = Array.from({ length: 201 }, (_, index) =>
      createEnvelope({ requestId: nthUuid(80_000 + index) }),
    );
    const later = Array.from({ length: 250 }, (_, index) =>
      createEnvelope({ requestId: nthUuid(81_000 + index) }),
    );
    const catalog = createNewestFirstCatalog(initial);
    let core = new FakeActionRequestCore(initial[0]!, {
      listPages: { "approved:not_started": [initial] },
    });
    const client = {
      async list(params: { approvalState: string; executionState: string; cursor?: string }) {
        if (params.approvalState !== "approved" || params.executionState !== "not_started") {
          return { items: [], nextCursor: null };
        }
        return catalog.list(params.cursor);
      },
      async get(actionRequestId: string) {
        return await core.get(actionRequestId);
      },
      async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
        return await core.claimExecution(params);
      },
      async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
        const updated = await core.updateExecution(params);
        if (params.update.state === "succeeded" || params.update.state === "failed") {
          catalog.remove(params.actionRequestId ?? updated.action_request.id);
        }
        return updated;
      },
    };

    const first = await new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      cursorStore: createFaultingCursorStore(
        { clear: ["approved:not_started"] },
        { delegate: createTestCursorStore(env), once: true },
      ),
    }).dispatchOnce();

    expect(first).toMatchObject({ succeeded: 201, errored: 1 });
    expect(executed.size).toBe(201);

    catalog.prepend(later);
    core = new FakeActionRequestCore(later[0]!, {
      listPages: { "approved:not_started": [later] },
    });
    resetPluginStateStoreForTests();

    const second = await new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      cursorStore: createTestCursorStore(env),
    }).dispatchOnce();

    expect(second).toMatchObject({ succeeded: 250, errored: 0, conflicted: 0 });
    expect(executed.size).toBe(451);
    expect(executeMutation).toHaveBeenCalledTimes(451);
  });

  it("clears an authoritative invalid_cursor and continues from the current head frontier", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    cursorStore.save({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
      nextCursor: "invalid-cursor",
    });
    const head = createEnvelope({ requestId: nthUuid(82_000) });
    const deep = createEnvelope({ requestId: nthUuid(82_010) });
    const queued = createEnvelope({
      requestId: nthUuid(82_001),
      executionState: "queued",
      rowVersion: 2,
    });
    const headCore = new FakeActionRequestCore(head);
    const deepCore = new FakeActionRequestCore(deep);
    const queuedCore = new FakeActionRequestCore(queued);
    const probeLimits: Array<number | undefined> = [];
    const result = await new YouPetActionRequestDispatcher({
      client: createInvalidCursorHealClient({
        head,
        deep,
        queued,
        headCore,
        deepCore,
        queuedCore,
        probeLimits,
      }),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
    }).dispatchOnce();

    expect(result).toMatchObject({ succeeded: 3, errored: 0, conflicted: 0 });
    expect(queuedCore.claims).toHaveLength(1);
    expect(headCore.claims).toHaveLength(1);
    expect(deepCore.claims).toHaveLength(1);
    expect(probeLimits).toEqual([1]);
    expect(
      cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).toBeUndefined();
  });

  it("does not reload an invalid_cursor after SQLite reopen", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    cursorStore.save({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
      nextCursor: "invalid-cursor",
    });
    const head = createEnvelope({ requestId: nthUuid(82_100) });
    const deep = createEnvelope({ requestId: nthUuid(82_110) });
    const queued = createEnvelope({
      requestId: nthUuid(82_101),
      executionState: "queued",
      rowVersion: 2,
    });
    await new YouPetActionRequestDispatcher({
      client: createInvalidCursorHealClient({
        head,
        deep,
        queued,
        headCore: new FakeActionRequestCore(head),
        deepCore: new FakeActionRequestCore(deep),
        queuedCore: new FakeActionRequestCore(queued),
      }),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
    }).dispatchOnce();

    resetPluginStateStoreForTests();
    const reopened = createTestCursorStore(env);
    expect(
      reopened.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).toBeUndefined();
  });

  it("drains older backlog after invalid_cursor heal while newer head pages keep arriving", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    cursorStore.save({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
      nextCursor: "invalid-cursor",
    });
    const older = Array.from({ length: 10 }, (_, index) =>
      createEnvelope({ requestId: nthUuid(84_000 + index) }),
    );
    const newer = Array.from({ length: 250 }, (_, index) =>
      createEnvelope({ requestId: nthUuid(84_100 + index) }),
    );
    const catalog = createNewestFirstCatalog(older);
    catalog.prepend(newer);
    const all = [...newer, ...older];
    const core = new FakeActionRequestCore(all[0]!, {
      listPages: { "approved:not_started": [all] },
    });
    const executed = new Set<string>();
    const result = await new YouPetActionRequestDispatcher({
      client: {
        async list(params: {
          approvalState: string;
          executionState: string;
          cursor?: string;
          limit?: number;
        }) {
          if (params.cursor === "invalid-cursor") {
            expect(params.limit).toBe(1);
            throw new YouPetActionRequestCoreError({
              status: 422,
              path: "/api/v1/action-requests",
              code: "invalid_cursor",
            });
          }
          if (params.approvalState !== "approved" || params.executionState !== "not_started") {
            return { items: [], nextCursor: null };
          }
          return catalog.list(params.cursor);
        },
        async get(actionRequestId: string) {
          return await core.get(actionRequestId);
        },
        async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
          return await core.claimExecution(params);
        },
        async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
          const updated = await core.updateExecution(params);
          if (params.update.state === "succeeded" || params.update.state === "failed") {
            catalog.remove(params.actionRequestId ?? updated.action_request.id);
            executed.add(params.actionRequestId ?? updated.action_request.id);
          }
          return updated;
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
    }).dispatchOnce();

    expect(result).toMatchObject({ succeeded: 260, errored: 0 });
    for (const item of older) {
      expect(executed.has(item.action_request.id)).toBe(true);
    }
  });

  it("stops only the faulting slice when invalid_cursor clear fails", async () => {
    const env = createYouPetTempStateEnv();
    const durable = createTestCursorStore(env);
    durable.save({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
      nextCursor: "invalid-cursor",
    });
    const head = createEnvelope({ requestId: nthUuid(82_200) });
    const queued = createEnvelope({
      requestId: nthUuid(82_201),
      executionState: "queued",
      rowVersion: 2,
    });
    const headCore = new FakeActionRequestCore(head);
    const queuedCore = new FakeActionRequestCore(queued);
    const logger = { error: vi.fn() };
    const result = await new YouPetActionRequestDispatcher({
      client: createInvalidCursorHealClient({
        head,
        deep: createEnvelope({ requestId: nthUuid(82_210) }),
        queued,
        headCore,
        deepCore: new FakeActionRequestCore(createEnvelope({ requestId: nthUuid(82_211) })),
        queuedCore,
      }),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore: createFaultingCursorStore(
        { clear: ["approved:not_started"] },
        { delegate: durable, once: true },
      ),
      logger,
    }).dispatchOnce();

    expect(result).toMatchObject({ succeeded: 2, errored: 1 });
    expect(queuedCore.claims).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "ActionRequest cursor slice approved/not_started failed: cursor clear failed",
      ),
    );
    expect(
      durable.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).toBe("invalid-cursor");
  });

  it("does not clear a durable cursor for an ordinary 422 probe", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    cursorStore.save({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
      nextCursor: "saved-cursor",
    });
    const queued = createEnvelope({
      requestId: nthUuid(82_300),
      executionState: "queued",
      rowVersion: 2,
    });
    const queuedCore = new FakeActionRequestCore(queued);
    const logger = { error: vi.fn() };
    const result = await new YouPetActionRequestDispatcher({
      client: {
        async list(params: { approvalState: string; executionState: string; cursor?: string }) {
          if (params.cursor === "saved-cursor") {
            throw new YouPetActionRequestCoreError({
              status: 422,
              path: "/api/v1/action-requests",
              code: "contract_validation_failed",
            });
          }
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(queued)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [], nextCursor: "saved-cursor" };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId: string) {
          return await queuedCore.get(actionRequestId);
        },
        async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
          return await queuedCore.claimExecution(params);
        },
        async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
          return await queuedCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
      logger,
    }).dispatchOnce();

    expect(result.errored).toBe(1);
    expect(queuedCore.claims).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("cursor probe failed"));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("422"));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("contract_validation_failed"),
    );
    expect(
      cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).toBe("saved-cursor");
  });

  it("isolates a probe 5xx without clearing the durable cursor", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    cursorStore.save({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
      nextCursor: "saved-cursor",
    });
    const queued = createEnvelope({
      requestId: nthUuid(82_400),
      executionState: "queued",
      rowVersion: 2,
    });
    const queuedCore = new FakeActionRequestCore(queued);
    const logger = { error: vi.fn() };
    const result = await new YouPetActionRequestDispatcher({
      client: {
        async list(params: { approvalState: string; executionState: string; cursor?: string }) {
          if (params.cursor === "saved-cursor") {
            throw new YouPetActionRequestCoreError({
              status: 503,
              path: "/api/v1/action-requests",
              code: "upstream_unavailable",
            });
          }
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(queued)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [], nextCursor: "saved-cursor" };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId: string) {
          return await queuedCore.get(actionRequestId);
        },
        async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
          return await queuedCore.claimExecution(params);
        },
        async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
          return await queuedCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
      logger,
    }).dispatchOnce();

    expect(result.errored).toBe(1);
    expect(queuedCore.claims).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("503"));
    expect(
      cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "not_started",
      }),
    ).toBe("saved-cursor");
  });

  it.each([
    { status: 401, code: "unauthorized" },
    { status: 403, code: "forbidden" },
    { status: 429, code: "rate_limited" },
  ])("aborts the dispatch cycle on probe $status $code", async ({ status, code }) => {
    const harness = createLaterSliceProbeHarness({
      laterRequestId: 84_000 + status,
      probeError: new YouPetActionRequestCoreError({
        status,
        path: "/api/v1/action-requests",
        code,
      }),
    });

    await expect(harness.dispatcher.dispatchOnce()).rejects.toMatchObject({
      name: "YouPetActionRequestCoreError",
      status,
      code,
    });
    expect(harness.laterCore.claims).toHaveLength(0);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expect(
      harness.cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "running",
      }),
    ).toBe("saved-cursor");
  });

  it("isolates a recognized probe transport error without clearing the durable cursor", async () => {
    const harness = createLaterSliceProbeHarness({
      laterRequestId: 84_503,
      probeError: new YouPetActionRequestTransportError({
        cause: Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }),
        path: "/api/v1/action-requests",
      }),
    });

    const result = await harness.dispatcher.dispatchOnce();

    expect(result).toMatchObject({ succeeded: 1, errored: 1 });
    expect(harness.laterCore.claims).toHaveLength(1);
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cursor probe failed"),
    );
    expect(
      harness.cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "running",
      }),
    ).toBe("saved-cursor");
  });

  it("aborts the dispatch cycle on an unexpected probe TypeError", async () => {
    const harness = createLaterSliceProbeHarness({
      laterRequestId: 84_600,
      probeError: new TypeError("Cannot read properties of undefined (reading 'items')"),
    });

    await expect(harness.dispatcher.dispatchOnce()).rejects.toBeInstanceOf(TypeError);
    expect(harness.laterCore.claims).toHaveLength(0);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expect(
      harness.cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "running",
      }),
    ).toBe("saved-cursor");
  });

  it("aborts the dispatch cycle on an unexpected probe Error", async () => {
    const harness = createLaterSliceProbeHarness({
      laterRequestId: 84_601,
      probeError: new Error("unexpected probe boom"),
    });

    await expect(harness.dispatcher.dispatchOnce()).rejects.toThrow(/unexpected probe boom/u);
    expect(harness.laterCore.claims).toHaveLength(0);
    expect(
      harness.cursorStore.load({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        approvalState: "approved",
        executionState: "running",
      }),
    ).toBe("saved-cursor");
  });

  it("wraps a real-client fetch transport failure as slice-local without aborting later slices", async () => {
    const harness = createRealClientProbeHarness({
      laterRequestId: 84_700,
      onProbe: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      },
    });

    const result = await harness.dispatcher.dispatchOnce();

    expect(result).toMatchObject({ succeeded: 1, errored: 1 });
    expect(harness.laterCore.claims).toHaveLength(1);
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cursor probe failed"),
    );
    expectSavedRunningCursor(harness.cursorStore);
  });

  it("isolates a body-stream UND_ERR_SOCKET probe without clearing the durable cursor", async () => {
    const harness = createRealClientProbeHarness({
      laterRequestId: 84_710,
      onProbe: async () =>
        failingBodyResponse(Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" })),
    });

    const result = await harness.dispatcher.dispatchOnce();

    expect(result).toMatchObject({ succeeded: 1, errored: 1 });
    expect(harness.laterCore.claims).toHaveLength(1);
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cursor probe failed"),
    );
    expectSavedRunningCursor(harness.cursorStore);
  });

  it("aborts the dispatch cycle on a caller AbortError probe", async () => {
    const harness = createRealClientProbeHarness({
      laterRequestId: 84_720,
      onProbe: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });

    await expect(harness.dispatcher.dispatchOnce()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(harness.laterCore.claims).toHaveLength(0);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expectSavedRunningCursor(harness.cursorStore);
  });

  it("aborts the dispatch cycle on a message-only fetch-failed programming probe", async () => {
    const harness = createRealClientProbeHarness({
      laterRequestId: 84_730,
      onProbe: async () => {
        throw new Error("fetch failed while building request headers");
      },
    });

    await expect(harness.dispatcher.dispatchOnce()).rejects.toThrow(
      /fetch failed while building request headers/u,
    );
    expect(harness.laterCore.claims).toHaveLength(0);
    expect(harness.logger.error).not.toHaveBeenCalled();
    expectSavedRunningCursor(harness.cursorStore);
  });

  it.each([
    {
      name: "structured UND_ERR_INVALID_ARG",
      laterRequestId: 84_740,
      onProbe: async () => {
        throw Object.assign(new TypeError("invalid argument"), { code: "UND_ERR_INVALID_ARG" });
      },
      expected: { name: "TypeError" },
    },
    {
      name: "message-only UND_ERR_INVALID_ARG",
      laterRequestId: 84_750,
      onProbe: async () => {
        throw new Error("Request failed with UND_ERR_INVALID_ARG");
      },
      expected: { message: "Request failed with UND_ERR_INVALID_ARG" },
    },
  ])(
    "aborts the dispatch cycle on a $name probe",
    async ({ laterRequestId, onProbe, expected }) => {
      const harness = createRealClientProbeHarness({ laterRequestId, onProbe });

      await expect(harness.dispatcher.dispatchOnce()).rejects.toMatchObject(expected);
      expect(harness.laterCore.claims).toHaveLength(0);
      expect(harness.logger.error).not.toHaveBeenCalled();
      expectSavedRunningCursor(harness.cursorStore);
    },
  );

  it("does not use an in-memory cursor when the durable store misses", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    const valid = createEnvelope({ requestId: nthUuid(83_000) });
    const validCore = new FakeActionRequestCore(valid);
    const requests: Array<string | undefined> = [];
    const client = createDeepBacklogClient(validCore, valid, requests);
    const dispatcher = new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
    });

    const first = await dispatcher.dispatchOnce();
    expect(first).toMatchObject({ succeeded: 0, errored: 0 });
    expect(requests.at(-1)).toBe("cursor-199");

    cursorStore.clear({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "not_started",
    });
    requests.length = 0;

    const second = await dispatcher.dispatchOnce();
    expect(second.errored).toBe(0);
    expect(requests[0]).toBeUndefined();
    expect(requests[1]).toBe("cursor-1");
  });

  it("isolates a cursor load fault and resumes the durable frontier after restart", async () => {
    const env = createYouPetTempStateEnv();
    const valid = createEnvelope({ requestId: nthUuid(83_100) });
    const validCore = new FakeActionRequestCore(valid);
    const durable = createTestCursorStore(env);

    const firstRequests: Array<string | undefined> = [];
    const first = await dispatchDeepBacklogOnce({
      validCore,
      valid,
      requests: firstRequests,
      cursorStore: durable,
    });
    expect(first).toMatchObject({ succeeded: 0, errored: 0 });

    const faulting = createFaultingCursorStore(
      { load: ["approved:not_started"] },
      { delegate: durable, once: true },
    );
    const logger = { error: vi.fn() };
    const second = await new YouPetActionRequestDispatcher({
      client: createDeepBacklogClient(validCore, valid, []),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore: faulting,
      logger,
    }).dispatchOnce();
    expect(second).toMatchObject({ errored: 1, succeeded: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "ActionRequest cursor slice approved/not_started failed: cursor load failed",
      ),
    );

    resetPluginStateStoreForTests();
    const resumedRequests: Array<string | undefined> = [];
    const third = await dispatchDeepBacklogOnce({
      validCore,
      valid,
      requests: resumedRequests,
      cursorStore: createTestCursorStore(env),
    });
    expect(third).toMatchObject({ claimed: 1, succeeded: 1, errored: 0 });
    expect(resumedRequests[0]).toBeUndefined();
    expect(resumedRequests).toContain("cursor-200");
  });

  it("bounds full-page backlog memory and resumes after the page budget", async () => {
    const valid = createEnvelope({ requestId: nthUuid(43_000) });
    const validCore = new FakeActionRequestCore(valid);
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    const client = {
      async list(params: { approvalState: string; executionState: string; cursor?: string }) {
        if (params.approvalState !== "approved" || params.executionState !== "not_started") {
          return { items: [], nextCursor: null };
        }
        const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
        if (pageIndex < 200) {
          return {
            items: Array.from({ length: 200 }, (_, itemIndex) =>
              createEnvelope({
                requestId: nthUuid(50_000 + pageIndex * 200 + itemIndex),
                proposerId: `foreign-agent-${pageIndex}-${itemIndex}`,
              }),
            ),
            nextCursor: `cursor-${pageIndex + 1}`,
          };
        }
        return { items: [structuredClone(valid)], nextCursor: null };
      },
      async get(actionRequestId: string) {
        return await validCore.get(actionRequestId);
      },
      async claimExecution(params: {
        actionRequestId?: string;
        claim: { worker_id: string; expected_row_version: number };
        idempotencyKey: string;
      }) {
        return await validCore.claimExecution(params);
      },
      async updateExecution(params: {
        actionRequestId?: string;
        update: YouPetActionRequestExecutionUpdate;
        idempotencyKey: string;
      }) {
        return await validCore.updateExecution(params);
      },
    };
    const dispatcher = new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "succeeded" as const, result: { outcome_code: "ok" } }),
      cursorStore,
    });

    const first = await dispatcher.dispatchOnce();
    const second = await new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "succeeded" as const, result: { outcome_code: "ok" } }),
      cursorStore,
    }).dispatchOnce();

    expect(first).toMatchObject({ listed: 40_000, skipped: 40_000, succeeded: 0 });
    expect(second).toMatchObject({ listed: 201, skipped: 200, succeeded: 1 });
  });

  it("does not reuse a persisted backlog cursor across tenant or actor boundaries", async () => {
    const env = createYouPetTempStateEnv();
    const cursorStore = createTestCursorStore(env);
    const valid = createEnvelope({ requestId: nthUuid(43_001) });
    const validCore = new FakeActionRequestCore(valid);
    const client = {
      async list(params: { approvalState: string; executionState: string; cursor?: string }) {
        if (params.approvalState !== "approved" || params.executionState !== "not_started") {
          return { items: [], nextCursor: null };
        }
        const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
        if (pageIndex < 200) {
          return {
            items: [
              createEnvelope({
                requestId: nthUuid(60_000 + pageIndex),
                proposerId: `foreign-agent-${pageIndex}`,
              }),
            ],
            nextCursor: `cursor-${pageIndex + 1}`,
          };
        }
        return { items: [structuredClone(valid)], nextCursor: null };
      },
      async get(actionRequestId: string) {
        return await validCore.get(actionRequestId);
      },
      async claimExecution(params: {
        actionRequestId?: string;
        claim: { worker_id: string; expected_row_version: number };
        idempotencyKey: string;
      }) {
        return await validCore.claimExecution(params);
      },
      async updateExecution(params: {
        actionRequestId?: string;
        update: YouPetActionRequestExecutionUpdate;
        idempotencyKey: string;
      }) {
        return await validCore.updateExecution(params);
      },
    };

    await new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      executeMutation: async () => ({ kind: "retry" as const }),
      cursorStore,
    }).dispatchOnce();

    await expect(
      new YouPetActionRequestDispatcher({
        client,
        tenantId: "00000000-0000-4000-8000-000000000199",
        actorId: ACTOR_ID,
        executeMutation: async () => ({ kind: "retry" as const }),
        cursorStore,
      }).dispatchOnce(),
    ).resolves.toMatchObject({ listed: 200, succeeded: 0 });
    await expect(
      new YouPetActionRequestDispatcher({
        client,
        tenantId: TENANT_ID,
        actorId: "openclaw-different-consumer",
        executeMutation: async () => ({ kind: "retry" as const }),
        cursorStore,
      }).dispatchOnce(),
    ).resolves.toMatchObject({ listed: 200, succeeded: 0 });
  });

  it("isolates one candidate error, logs a secret-safe summary, and still executes later candidates", async () => {
    const broken = createEnvelope({ requestId: nthUuid(950) });
    const valid = createEnvelope({ requestId: nthUuid(951) });
    const logger = {
      error: vi.fn(),
    };
    const executeMutation = vi.fn(async ({ envelope }) => {
      if (envelope.action_request.id === broken.action_request.id) {
        throw new Error("boom secret token sk-should-not-appear");
      }
      return { kind: "succeeded" as const, result: { outcome_code: "task_escalated" } };
    });
    const dispatcher = new YouPetActionRequestDispatcher({
      client: new FakeActionRequestCore(valid, {
        listPages: {
          "approved:not_started": [[broken, valid]],
        },
      }),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      logger,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      claimed: 2,
      succeeded: 1,
      errored: 1,
      failed: 0,
      conflicted: 0,
    });
    expect(executeMutation).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      `[youpet] ActionRequest ${broken.action_request.id} dispatch failed: candidate execution aborted`,
    );
    expect(logger.error.mock.calls[0]?.[0]).not.toContain("sk-should-not-appear");
  });

  it("lets only one concurrent worker win the not-started CAS", async () => {
    const state = createEnvelope();
    const firstClient = new FakeActionRequestCore(state, { frozenList: createEnvelope() });
    const secondClient = new FakeActionRequestCore(state, { frozenList: createEnvelope() });
    secondClient.shareStateWith(firstClient);
    const mutations: string[] = [];
    const run = (client: FakeActionRequestCore, workerId: string) =>
      new YouPetActionRequestDispatcher({
        client,
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        workerId,
        executeMutation: async ({ idempotencyKey }) => {
          mutations.push(idempotencyKey);
          return { kind: "succeeded", result: { outcome_code: "task_escalated" } };
        },
      }).dispatchOnce();

    const [first, second] = await Promise.all([
      run(firstClient, "worker-a"),
      run(secondClient, "worker-b"),
    ]);

    expect(first.succeeded + second.succeeded).toBe(1);
    expect(first.conflicted + second.conflicted).toBe(1);
    expect(mutations).toHaveLength(1);
  });

  it("renews the same owner's running lease before retrying work", async () => {
    const currentNow = new Date("2026-08-10T00:00:00Z");
    const running = createEnvelope({
      executionState: "running",
      rowVersion: 3,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T02:10:00Z",
    });
    const firstCore = new FakeActionRequestCore(running, { now: () => currentNow });
    const firstKeys: string[] = [];
    const first = new YouPetActionRequestDispatcher({
      client: firstCore,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: async ({ idempotencyKey }) => {
        firstKeys.push(idempotencyKey);
        return { kind: "retry" };
      },
      now: () => currentNow,
    });
    expect(await first.dispatchOnce()).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    expect(firstCore.claims).toHaveLength(1);

    const secondKeys: string[] = [];
    const second = new YouPetActionRequestDispatcher({
      client: firstCore,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: async ({ idempotencyKey }) => {
        secondKeys.push(idempotencyKey);
        return { kind: "succeeded", result: { outcome_code: "task_escalated" } };
      },
      now: () => currentNow,
    });
    expect(await second.dispatchOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(secondKeys).toEqual(firstKeys);
    expect(firstCore.claims[1]?.idempotencyKey).not.toBe(firstCore.claims[0]?.idempotencyKey);
  });

  it("allows lease takeover after expiry with the same downstream mutation key", async () => {
    const baseNow = new Date();
    let currentNow = new Date(baseNow);
    const running = createEnvelope({
      executionState: "running",
      rowVersion: 3,
      executionClaimOwnerId: "worker-before-restart",
      executionClaimLeaseExpiresAt: new Date(baseNow.valueOf() + 60_000).toISOString(),
    });
    const firstCore = new FakeActionRequestCore(running, { now: () => currentNow });
    const firstKeys: string[] = [];
    const first = new YouPetActionRequestDispatcher({
      client: firstCore,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-before-restart",
      executeMutation: async ({ idempotencyKey }) => {
        firstKeys.push(idempotencyKey);
        return { kind: "retry" };
      },
      now: () => currentNow,
    });
    expect(await first.dispatchOnce()).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });

    const firstLeaseExpiry = new Date(
      (await firstCore.get()).execution_claim?.lease_expires_at ?? "",
    );
    currentNow = new Date(firstLeaseExpiry.valueOf() + 1_000);
    const secondKeys: string[] = [];
    const second = new YouPetActionRequestDispatcher({
      client: firstCore,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-after-restart",
      executeMutation: async ({ idempotencyKey }) => {
        secondKeys.push(idempotencyKey);
        return { kind: "succeeded", result: { outcome_code: "task_escalated" } };
      },
      now: () => currentNow,
    });
    expect(await second.dispatchOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(secondKeys).toEqual(firstKeys);
  });

  it("lets only one competing worker execute an already-running request", async () => {
    const currentNow = new Date("2026-08-10T00:10:00Z");
    const running = createEnvelope({
      executionState: "running",
      rowVersion: 3,
      executionClaimOwnerId: "worker-old",
      executionClaimLeaseExpiresAt: "2026-08-10T00:00:00Z",
    });
    const firstClient = new FakeActionRequestCore(running, {
      frozenList: structuredClone(running),
      now: () => currentNow,
    });
    const secondClient = new FakeActionRequestCore(running, {
      frozenList: structuredClone(running),
      now: () => currentNow,
    });
    secondClient.shareStateWith(firstClient);
    const mutations: string[] = [];
    const run = (client: FakeActionRequestCore, workerId: string) =>
      new YouPetActionRequestDispatcher({
        client,
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        workerId,
        executeMutation: async ({ idempotencyKey }) => {
          mutations.push(idempotencyKey);
          return { kind: "succeeded", result: { outcome_code: "task_escalated" } };
        },
        now: () => currentNow,
      }).dispatchOnce();

    const [first, second] = await Promise.all([
      run(firstClient, "worker-a"),
      run(secondClient, "worker-b"),
    ]);

    expect(first.succeeded + second.succeeded).toBe(1);
    expect(first.conflicted + second.conflicted).toBe(1);
    expect(mutations).toHaveLength(1);
  });

  it("treats a terminal lease conflict as a recoverable dispatcher conflict", async () => {
    const currentNow = new Date("2026-08-10T01:00:00Z");
    const running = createEnvelope({
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T02:10:00Z",
    });
    const client = {
      async list() {
        return { items: [structuredClone(running)], nextCursor: null };
      },
      async get() {
        return structuredClone(running);
      },
      async claimExecution() {
        return structuredClone(running);
      },
      async updateExecution() {
        throw new YouPetActionRequestCoreError({
          status: 409,
          path: "/execution-status",
          code: "execution_lease_conflict",
        });
      },
    };
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => currentNow,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      conflicted: 1,
      succeeded: 0,
    });
    expect(executeMutation).toHaveBeenCalledOnce();
  });

  it("fails an expired running request without executing the mutation when this worker still owns the active lease", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const running = createEnvelope({
      requestId: nthUuid(980),
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T01:20:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const executeMutation = vi.fn();
    const core = new FakeActionRequestCore(running, { now: () => currentNow });
    const dispatcher = new YouPetActionRequestDispatcher({
      client: core,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => currentNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({ failed: 1, claimed: 0, conflicted: 0, succeeded: 0 });
    expect(executeMutation).not.toHaveBeenCalled();
    expect(core.updates[0]).toMatchObject({
      update: {
        state: "failed",
        expected_row_version: 4,
        worker_id: "worker-a",
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      },
    });
  });

  it("sends the exact expired-authorization recovery payload, counts a failed recovery, and continues later candidates when the lease is expired", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const expired = createEnvelope({
      requestId: nthUuid(981),
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T01:00:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(982) });
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const core = new FakeActionRequestCore(valid, {
      now: () => currentNow,
      listPages: {
        "approved:running": [[expired]],
        "approved:not_started": [[valid]],
      },
    });
    const dispatcher = new YouPetActionRequestDispatcher({
      client: core,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => currentNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      conflicted: 0,
      claimed: 1,
      succeeded: 1,
      failed: 1,
      errored: 0,
    });
    expect(executeMutation).toHaveBeenCalledOnce();
    expect(core.updateAttempts[0]).toMatchObject({
      update: {
        state: "failed",
        expected_row_version: 4,
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      },
    });
    expect(core.updateAttempts[0]?.update).not.toHaveProperty("worker_id");
  });

  it("treats an execution_authorization_expired claim race as a candidate conflict and still executes later candidates", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const raced = createEnvelope({
      requestId: nthUuid(986),
      executionState: "queued",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:15:00Z",
    });
    const expiredLatest = createEnvelope({
      requestId: nthUuid(986),
      executionState: "queued",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(987) });
    const validCore = new FakeActionRequestCore(valid, { now: () => currentNow });
    const raceUpdates: YouPetActionRequestExecutionUpdate[] = [];
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(raced)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [structuredClone(valid)], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          if (actionRequestId === raced.action_request.id) {
            return structuredClone(expiredLatest);
          }
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          if (params.actionRequestId === raced.action_request.id) {
            throw new YouPetActionRequestCoreError({
              status: 409,
              path: "/execution-claim",
              code: "execution_authorization_expired",
            });
          }
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          if (params.actionRequestId === raced.action_request.id) {
            raceUpdates.push(params.update);
            return {
              ...structuredClone(expiredLatest),
              action_request: {
                ...expiredLatest.action_request,
                execution: { state: "failed" },
              },
              row_version: expiredLatest.row_version + 1,
              execution_claim: null,
            };
          }
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => currentNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      failed: 0,
      claimed: 1,
      succeeded: 1,
      conflicted: 1,
      errored: 0,
    });
    expect(executeMutation).toHaveBeenCalledOnce();
    expect(raceUpdates).toEqual([]);
  });

  it("isolates execution_authorization_expired while queuing not_started and continues later candidates", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const raced = createEnvelope({
      requestId: nthUuid(20_398),
      executionState: "not_started",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:15:00Z",
    });
    const expiredLatest = createEnvelope({
      requestId: nthUuid(20_398),
      executionState: "not_started",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(20_399) });
    const validCore = new FakeActionRequestCore(valid, { now: () => currentNow });
    const racedUpdates: YouPetActionRequestExecutionUpdate[] = [];
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [structuredClone(raced), structuredClone(valid)], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          if (actionRequestId === raced.action_request.id) {
            return structuredClone(expiredLatest);
          }
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          if (params.actionRequestId === raced.action_request.id) {
            racedUpdates.push(structuredClone(params.update));
            throw new YouPetActionRequestCoreError({
              status: 409,
              path: "/execution-status",
              code: "execution_authorization_expired",
            });
          }
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => currentNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      failed: 0,
      claimed: 1,
      succeeded: 1,
      conflicted: 1,
      errored: 0,
    });
    expect(racedUpdates).toEqual([{ state: "queued", expected_row_version: 2 }]);
    expect(executeMutation).toHaveBeenCalledOnce();
  });

  it("treats a Core-expired running refetch as authoritative even when the worker clock is still behind policy expiry", async () => {
    const workerNow = new Date("2026-08-10T01:03:00Z");
    const queued = createEnvelope({
      requestId: nthUuid(20_400),
      executionState: "queued",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const legacyRunningExpired = createEnvelope({
      requestId: nthUuid(20_400),
      executionState: "running",
      rowVersion: 4,
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(20_401) });
    const validCore = new FakeActionRequestCore(valid, { now: () => workerNow });
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const raceUpdates: YouPetActionRequestExecutionUpdate[] = [];
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(queued)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [structuredClone(valid)], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          if (actionRequestId === queued.action_request.id) {
            return structuredClone(legacyRunningExpired);
          }
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            throw new YouPetActionRequestCoreError({
              status: 409,
              path: "/execution-claim",
              code: "execution_authorization_expired",
            });
          }
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            raceUpdates.push(params.update);
            return {
              ...structuredClone(legacyRunningExpired),
              action_request: {
                ...legacyRunningExpired.action_request,
                execution: { state: "failed" },
              },
              execution_claim: null,
              row_version: legacyRunningExpired.row_version + 1,
            };
          }
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => workerNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      failed: 1,
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
      errored: 0,
    });
    expect(raceUpdates).toEqual([
      {
        state: "failed",
        expected_row_version: 4,
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      },
    ]);
    expect(executeMutation).toHaveBeenCalledOnce();
  });

  it("uses worker-owned authoritative recovery when Core still requires the active lease owner", async () => {
    const workerNow = new Date("2026-08-10T01:03:00Z");
    const queued = createEnvelope({
      requestId: nthUuid(20_402),
      executionState: "queued",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const latestRunning = createEnvelope({
      requestId: nthUuid(20_402),
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T01:20:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(20_403) });
    const validCore = new FakeActionRequestCore(valid, { now: () => workerNow });
    const recoveryAttempts: Array<{
      update: YouPetActionRequestExecutionUpdate;
      idempotencyKey: string;
    }> = [];
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(queued)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [structuredClone(valid)], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          if (actionRequestId === queued.action_request.id) {
            return structuredClone(latestRunning);
          }
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            throw new YouPetActionRequestCoreError({
              status: 409,
              path: "/execution-claim",
              code: "execution_authorization_expired",
            });
          }
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            recoveryAttempts.push({
              update: structuredClone(params.update),
              idempotencyKey: params.idempotencyKey,
            });
            expect(params.update.worker_id).toBe("worker-a");
            return {
              ...structuredClone(latestRunning),
              action_request: {
                ...latestRunning.action_request,
                execution: { state: "failed" },
              },
              execution_claim: null,
              row_version: latestRunning.row_version + 1,
            };
          }
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => workerNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      failed: 1,
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
      errored: 0,
    });
    expect(recoveryAttempts).toHaveLength(1);
    expect(recoveryAttempts[0]).toMatchObject({
      update: {
        state: "failed",
        expected_row_version: 4,
        worker_id: "worker-a",
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      },
    });
    expect(executeMutation).toHaveBeenCalledOnce();
  });

  it("falls back from an invalid worker-owned expired recovery body to a workerless recovery", async () => {
    const workerNow = new Date("2026-08-10T01:21:00Z");
    const queued = createEnvelope({
      requestId: nthUuid(20_404),
      executionState: "queued",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:25:00Z",
    });
    const latestRunning = createEnvelope({
      requestId: nthUuid(20_404),
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T01:20:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(20_405) });
    const validCore = new FakeActionRequestCore(valid, { now: () => workerNow });
    let queuedRecoveryAttempt = 0;
    const recoveryAttempts: Array<{
      update: YouPetActionRequestExecutionUpdate;
      idempotencyKey: string;
    }> = [];
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(queued)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [structuredClone(valid)], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          if (actionRequestId === queued.action_request.id) {
            return structuredClone(latestRunning);
          }
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            throw new YouPetActionRequestCoreError({
              status: 409,
              path: "/execution-claim",
              code: "execution_authorization_expired",
            });
          }
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            queuedRecoveryAttempt += 1;
            recoveryAttempts.push({
              update: structuredClone(params.update),
              idempotencyKey: params.idempotencyKey,
            });
            if (queuedRecoveryAttempt === 1) {
              throw new YouPetActionRequestCoreError({
                status: 409,
                path: "/execution-status",
                code: "invalid_execution_body",
              });
            }
            return {
              ...structuredClone(latestRunning),
              action_request: {
                ...latestRunning.action_request,
                execution: { state: "failed" },
              },
              execution_claim: null,
              row_version: latestRunning.row_version + 1,
            };
          }
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => workerNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      failed: 1,
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
      errored: 0,
    });
    expect(recoveryAttempts).toHaveLength(2);
    expect(recoveryAttempts[0]).toMatchObject({
      update: {
        state: "failed",
        expected_row_version: 4,
        worker_id: "worker-a",
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      },
    });
    expect(recoveryAttempts[1]).toMatchObject({
      update: {
        state: "failed",
        expected_row_version: 4,
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      },
    });
    expect(recoveryAttempts[0]?.idempotencyKey).not.toBe(recoveryAttempts[1]?.idempotencyKey);
    expect(recoveryAttempts[1]?.update).not.toHaveProperty("worker_id");
    expect(executeMutation).toHaveBeenCalledOnce();
    expect(executeMutation.mock.calls[0]?.[0]?.envelope.action_request.id).toBe(
      valid.action_request.id,
    );
  });

  it("composes FakeActionRequestCore worker-owned rejection through dispatcher workerless fallback", async () => {
    const workerNow = new Date("2026-08-10T01:21:00Z");
    const queued = createEnvelope({
      requestId: nthUuid(20_500),
      executionState: "queued",
      rowVersion: 2,
      policyExpiresAt: "2026-08-10T01:25:00Z",
    });
    const latestRunning = createEnvelope({
      requestId: nthUuid(20_500),
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-a",
      executionClaimLeaseExpiresAt: "2026-08-10T01:20:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(20_501) });
    const recoveryCore = new FakeActionRequestCore(latestRunning, { now: () => workerNow });
    const validCore = new FakeActionRequestCore(valid, { now: () => workerNow });
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(queued)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "not_started") {
            return { items: [structuredClone(valid)], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId) {
          if (actionRequestId === queued.action_request.id) {
            return await recoveryCore.get(actionRequestId);
          }
          return await validCore.get(actionRequestId);
        },
        async claimExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            throw new YouPetActionRequestCoreError({
              status: 409,
              path: "/execution-claim",
              code: "execution_authorization_expired",
            });
          }
          return await validCore.claimExecution(params);
        },
        async updateExecution(params) {
          if (params.actionRequestId === queued.action_request.id) {
            return await recoveryCore.updateExecution(params);
          }
          return await validCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => workerNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({
      failed: 1,
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
      errored: 0,
    });
    expect(recoveryCore.updateAttempts).toHaveLength(2);
    expect(recoveryCore.updateAttempts[0]?.update.worker_id).toBe("worker-a");
    expect(recoveryCore.updateAttempts[1]?.update).not.toHaveProperty("worker_id");
    expect(recoveryCore.updateAttempts[0]?.update.expected_row_version).toBe(4);
    expect(recoveryCore.updateAttempts[1]?.update.expected_row_version).toBe(4);
    expect(recoveryCore.updateAttempts[0]?.idempotencyKey).not.toBe(
      recoveryCore.updateAttempts[1]?.idempotencyKey,
    );
    expect(executeMutation).toHaveBeenCalledOnce();
    expect(executeMutation.mock.calls[0]?.[0]?.envelope.action_request.id).toBe(
      valid.action_request.id,
    );
  });

  it("leaves an expired running request alone when another worker still owns the active lease", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const foreignRunning = createEnvelope({
      requestId: nthUuid(983),
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "worker-foreign",
      executionClaimLeaseExpiresAt: "2026-08-10T01:20:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const valid = createEnvelope({ requestId: nthUuid(984) });
    const executeMutation = vi.fn(async () => ({
      kind: "succeeded" as const,
      result: { outcome_code: "task_escalated" },
    }));
    const logger = { warn: vi.fn() };
    const core = new FakeActionRequestCore(valid, {
      now: () => currentNow,
      listPages: {
        "approved:running": [[foreignRunning]],
        "approved:not_started": [[valid]],
      },
    });
    const dispatcher = new YouPetActionRequestDispatcher({
      client: core,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      logger,
      now: () => currentNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({ skipped: 1, claimed: 1, succeeded: 1, conflicted: 0 });
    expect(core.updateAttempts).toHaveLength(2);
    expect(core.updateAttempts[0]?.update.state).toBe("queued");
    expect(logger.warn).toHaveBeenCalledWith(
      `[youpet] Leaving expired running ActionRequest ${foreignRunning.action_request.id} with active foreign owner worker-foreign`,
    );
  });

  it("never recovers an expired running request outside the closed YouPet route inventory", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const foreign = createEnvelope({
      requestId: nthUuid(985),
      proposerId: "foreign-agent",
      executionState: "running",
      rowVersion: 4,
      executionClaimOwnerId: "foreign-worker",
      executionClaimLeaseExpiresAt: "2026-08-10T01:00:00Z",
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    const executeMutation = vi.fn();
    const core = new FakeActionRequestCore(foreign, { now: () => currentNow });
    const dispatcher = new YouPetActionRequestDispatcher({
      client: core,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
      now: () => currentNow,
    });

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({ skipped: 1, failed: 0, errored: 0, conflicted: 0 });
    expect(core.updateAttempts).toEqual([]);
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "require_approval", undefined, { skipped: 1, failed: 0 }, 0],
    ["rejected", "require_approval", undefined, { skipped: 1, failed: 0 }, 0],
    ["expired", "require_approval", undefined, { skipped: 1, failed: 0 }, 0],
    ["not_required", "deny", undefined, { skipped: 1, failed: 0 }, 0],
    ["approved", "require_approval", "2026-08-09T00:00:00Z", { skipped: 1, failed: 0 }, 0],
    ["approved", "require_approval", "not-a-date", { skipped: 1, failed: 0 }, 0],
  ])(
    "fails closed for approval=%s policy=%s",
    async (approval, policy, expiresAt, expected, expectedUpdateCount) => {
      const envelope = createEnvelope({
        approvalState: approval,
        policyOutcome: policy,
        policyExpiresAt: expiresAt,
      });
      const core = new FakeActionRequestCore(envelope, { includeRegardlessOfFilters: true });
      const executeMutation = vi.fn();
      const dispatcher = new YouPetActionRequestDispatcher({
        client: core,
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        executeMutation,
        now: () => new Date("2026-08-10T00:00:00Z"),
      });

      expect(await dispatcher.dispatchOnce()).toMatchObject({ ...expected, claimed: 0 });
      expect(executeMutation).not.toHaveBeenCalled();
      expect(core.updates).toHaveLength(expectedUpdateCount);
    },
  );

  it("rejects unmapped or foreign requests before execution", () => {
    const envelope = createEnvelope();
    expect(
      matchActionRequestRoute(
        {
          ...envelope,
          action_request: {
            ...envelope.action_request,
            proposer: { type: "agent", id: "another-agent" },
          },
        },
        { tenantId: TENANT_ID, actorId: ACTOR_ID, now: new Date("2026-08-09T02:00:00Z") },
      ),
    ).toBeUndefined();
    expect(
      matchActionRequestRoute(
        {
          ...envelope,
          action_request: { ...envelope.action_request, action_type: "tool.invoke" },
        },
        { tenantId: TENANT_ID, actorId: ACTOR_ID, now: new Date("2026-08-09T02:00:00Z") },
      ),
    ).toBeUndefined();
  });

  it.each([
    { risk: "low", policyOutcome: "require_approval", requiredApproverClass: "operator" },
    { risk: "high", policyOutcome: "allow", requiredApproverClass: undefined },
    { risk: "high", policyOutcome: "require_approval", requiredApproverClass: null },
  ])(
    "rejects task escalation with downgraded route policy %#",
    ({ risk, policyOutcome, requiredApproverClass }) => {
      const envelope = createEnvelope({
        risk,
        policyOutcome,
        requiredApproverClass,
        approvalState: policyOutcome === "allow" ? "not_required" : "approved",
      });

      expect(
        matchActionRequestRoute(envelope, {
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          now: new Date("2026-08-09T02:00:00Z"),
        }),
      ).toBeUndefined();
    },
  );

  it("rejects a health-plan route whose low-risk allow policy was replaced by approval", () => {
    const envelope = createEnvelope({
      approvalState: "approved",
      policyOutcome: "require_approval",
      requiredApproverClass: "operator",
      risk: "low",
    });
    envelope.action_request = {
      ...envelope.action_request,
      target: { type: "health_plan", id: PLAN_ID },
      action_type: "workflow.mutate",
      payload: {
        mode: "inline",
        fields: { health_plan_id: PLAN_ID, openclaw_flow_id: "flow-1" },
      },
    };

    expect(
      matchActionRequestRoute(envelope, {
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        now: new Date("2026-08-09T02:00:00Z"),
      }),
    ).toBeUndefined();
  });
});

describe("FakeActionRequestCore policy-expired recovery contract", () => {
  it("permits workerless failed recovery when the running lease is expired", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const core = new FakeActionRequestCore(
      createEnvelope({
        requestId: nthUuid(20_300),
        executionState: "running",
        rowVersion: 4,
        executionClaimOwnerId: "worker-a",
        executionClaimLeaseExpiresAt: "2026-08-10T01:00:00Z",
        policyExpiresAt: "2026-08-10T01:05:00Z",
      }),
      { now: () => currentNow },
    );

    await expect(
      core.updateExecution({
        update: {
          state: "failed",
          expected_row_version: 4,
          error: {
            code: "execution_authorization_expired",
            message: "policy expired before execution completed",
          },
        },
        idempotencyKey: "workerless-expired-lease",
      }),
    ).resolves.toMatchObject({
      action_request: { execution: { state: "failed" } },
      execution_claim: null,
      row_version: 5,
    });
  });

  it("permits workerless failed recovery for legacy both-null claim metadata", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const legacy = createEnvelope({
      requestId: nthUuid(20_301),
      executionState: "running",
      rowVersion: 4,
      policyExpiresAt: "2026-08-10T01:05:00Z",
    });
    legacy.execution_claim = {
      owner_id: null,
      lease_expires_at: null,
    } as unknown as NonNullable<YouPetActionRequestEnvelope["execution_claim"]>;
    const core = new FakeActionRequestCore(legacy, { now: () => currentNow });

    await expect(
      core.updateExecution({
        update: {
          state: "failed",
          expected_row_version: 4,
          error: {
            code: "execution_authorization_expired",
            message: "policy expired before execution completed",
          },
        },
        idempotencyKey: "workerless-legacy-null",
      }),
    ).resolves.toMatchObject({
      action_request: { execution: { state: "failed" } },
      execution_claim: null,
      row_version: 5,
    });
  });

  it.each([
    [undefined, "missing-policy-expiry"],
    ["not-a-date", "malformed-policy-expiry"],
    ["2026-08-10T01:15:00Z", "future-policy-expiry"],
  ])(
    "rejects workerless recovery when policy expiry is not recoverably expired (%s)",
    async (policyExpiresAt, idempotencyKey) => {
      const currentNow = new Date("2026-08-10T01:10:00Z");
      const core = new FakeActionRequestCore(
        createEnvelope({
          requestId: nthUuid(20_304),
          executionState: "running",
          rowVersion: 4,
          executionClaimOwnerId: "worker-a",
          executionClaimLeaseExpiresAt: "2026-08-10T01:00:00Z",
          policyExpiresAt,
        }),
        { now: () => currentNow },
      );

      await expect(
        core.updateExecution({
          update: {
            state: "failed",
            expected_row_version: 4,
            error: {
              code: "execution_authorization_expired",
              message: "any message is ignored by the fake parity gate",
            },
          },
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        status: 409,
        path: "/execution-status",
        code: "execution_claim_required",
      });
    },
  );

  it("matches Core by rejecting workerless recovery bodies that carry a result payload", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const core = new FakeActionRequestCore(
      createEnvelope({
        requestId: nthUuid(20_305),
        executionState: "running",
        rowVersion: 4,
        executionClaimOwnerId: "worker-a",
        executionClaimLeaseExpiresAt: "2026-08-10T01:00:00Z",
        policyExpiresAt: "2026-08-10T01:05:00Z",
      }),
      { now: () => currentNow },
    );

    await expect(
      core.updateExecution({
        update: {
          state: "failed",
          expected_row_version: 4,
          result: { outcome_code: "must-not-exist" },
          error: {
            code: "execution_authorization_expired",
            message: "policy expired before execution completed",
          },
        },
        idempotencyKey: "workerless-expired-result",
      }),
    ).rejects.toMatchObject({
      status: 409,
      path: "/execution-status",
      code: "invalid_execution_body",
    });
  });

  it("matches Core by forcing expired worker-owned recovery bodies to retry workerless", async () => {
    const currentNow = new Date("2026-08-10T01:10:00Z");
    const core = new FakeActionRequestCore(
      createEnvelope({
        requestId: nthUuid(20_306),
        executionState: "running",
        rowVersion: 4,
        executionClaimOwnerId: "worker-a",
        executionClaimLeaseExpiresAt: "2026-08-10T01:00:00Z",
        policyExpiresAt: "2026-08-10T01:05:00Z",
      }),
      { now: () => currentNow },
    );

    await expect(
      core.updateExecution({
        update: {
          state: "failed",
          expected_row_version: 4,
          worker_id: "worker-a",
          error: {
            code: "execution_authorization_expired",
            message: "policy expired before execution completed",
          },
        },
        idempotencyKey: "owned-expired-recovery",
      }),
    ).rejects.toMatchObject({
      status: 409,
      path: "/execution-status",
      code: "invalid_execution_body",
    });
  });

  it.each([
    [{ owner_id: "worker-a", lease_expires_at: null }, "owner-without-expiry"],
    [{ owner_id: null, lease_expires_at: "2026-08-10T01:00:00Z" }, "expiry-without-owner"],
  ])(
    "fails closed for partial-null running claim metadata (%s)",
    async (executionClaim, idempotencyKey) => {
      const currentNow = new Date("2026-08-10T01:10:00Z");
      const partial = createEnvelope({
        requestId: nthUuid(20_302),
        executionState: "running",
        rowVersion: 4,
        policyExpiresAt: "2026-08-10T01:05:00Z",
      });
      partial.execution_claim = executionClaim as unknown as NonNullable<
        YouPetActionRequestEnvelope["execution_claim"]
      >;
      const core = new FakeActionRequestCore(partial, { now: () => currentNow });

      await expect(
        core.updateExecution({
          update: {
            state: "failed",
            expected_row_version: 4,
            error: {
              code: "execution_authorization_expired",
              message: "policy expired before execution completed",
            },
          },
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        status: 409,
        path: "/execution-status",
        code: "execution_claim_required",
      });
    },
  );
});

function createLaterSliceProbeHarness(options: { laterRequestId: number; probeError: unknown }) {
  const env = createYouPetTempStateEnv();
  const cursorStore = createTestCursorStore(env);
  cursorStore.save({
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    approvalState: "approved",
    executionState: "running",
    nextCursor: "saved-cursor",
  });
  const later = createEnvelope({
    requestId: nthUuid(options.laterRequestId),
    executionState: "queued",
    rowVersion: 2,
  });
  const laterCore = new FakeActionRequestCore(later);
  const logger = { error: vi.fn() };
  return {
    cursorStore,
    laterCore,
    logger,
    dispatcher: new YouPetActionRequestDispatcher({
      client: {
        async list(params: { approvalState: string; executionState: string; cursor?: string }) {
          if (params.cursor === "saved-cursor") {
            throw options.probeError;
          }
          if (params.approvalState === "approved" && params.executionState === "queued") {
            return { items: [structuredClone(later)], nextCursor: null };
          }
          if (params.approvalState === "approved" && params.executionState === "running") {
            return { items: [], nextCursor: "saved-cursor" };
          }
          return { items: [], nextCursor: null };
        },
        async get(actionRequestId: string) {
          return await laterCore.get(actionRequestId);
        },
        async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
          return await laterCore.claimExecution(params);
        },
        async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
          return await laterCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
      logger,
    }),
  };
}

function createActionRequestClient(
  fetchFn: ConstructorParameters<typeof YouPetActionRequestClient>[0]["fetchFn"],
) {
  return new YouPetActionRequestClient({
    coreBaseUrl: "https://core.example.com",
    serviceToken: "svc-token",
    actorId: ACTOR_ID,
    fetchFn,
  });
}

async function rejectClientList(
  fetchFn: NonNullable<ConstructorParameters<typeof YouPetActionRequestClient>[0]["fetchFn"]>,
): Promise<unknown> {
  return await createActionRequestClient(fetchFn)
    .list({
      tenantId: TENANT_ID,
      approvalState: "approved",
      executionState: "not_started",
    })
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
}

function failingBodyResponse(error: Error): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function expectSavedRunningCursor(cursorStore: YouPetActionRequestCursorStore): void {
  expect(
    cursorStore.load({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      approvalState: "approved",
      executionState: "running",
    }),
  ).toBe("saved-cursor");
}

function createRealClientProbeHarness(options: {
  laterRequestId: number;
  onProbe: () => Promise<Response>;
}) {
  const env = createYouPetTempStateEnv();
  const cursorStore = createTestCursorStore(env);
  cursorStore.save({
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    approvalState: "approved",
    executionState: "running",
    nextCursor: "saved-cursor",
  });
  const later = createEnvelope({
    requestId: nthUuid(options.laterRequestId),
    executionState: "queued",
    rowVersion: 2,
  });
  const laterCore = new FakeActionRequestCore(later);
  const actionRequests = createActionRequestClient(async (input) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.searchParams.get("cursor") === "saved-cursor") {
      return await options.onProbe();
    }
    if (
      url.searchParams.get("approval_state") === "approved" &&
      url.searchParams.get("execution_state") === "queued"
    ) {
      return jsonResponse({ items: [later], count: 1, next_cursor: null });
    }
    if (
      url.searchParams.get("approval_state") === "approved" &&
      url.searchParams.get("execution_state") === "running"
    ) {
      return jsonResponse({ items: [], count: 0, next_cursor: "saved-cursor" });
    }
    return jsonResponse({ items: [], count: 0, next_cursor: null });
  });
  const logger = { error: vi.fn() };
  return {
    cursorStore,
    laterCore,
    logger,
    dispatcher: new YouPetActionRequestDispatcher({
      client: {
        list: async (params) => await actionRequests.list(params),
        async get(actionRequestId: string) {
          return await laterCore.get(actionRequestId);
        },
        async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
          return await laterCore.claimExecution(params);
        },
        async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
          return await laterCore.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation: executeSuccessfulMutation,
      cursorStore,
      logger,
    }),
  };
}

function createInvalidCursorHealClient(options: {
  head: YouPetActionRequestEnvelope;
  deep: YouPetActionRequestEnvelope;
  queued: YouPetActionRequestEnvelope;
  headCore: InstanceType<typeof FakeActionRequestCore>;
  deepCore: InstanceType<typeof FakeActionRequestCore>;
  queuedCore: InstanceType<typeof FakeActionRequestCore>;
  probeLimits?: Array<number | undefined>;
}) {
  const coreFor = (actionRequestId: string) => {
    if (actionRequestId === options.head.action_request.id) {
      return options.headCore;
    }
    if (actionRequestId === options.deep.action_request.id) {
      return options.deepCore;
    }
    return options.queuedCore;
  };
  return {
    async list(params: {
      approvalState: string;
      executionState: string;
      cursor?: string;
      limit?: number;
    }) {
      if (params.cursor === "invalid-cursor") {
        options.probeLimits?.push(params.limit);
        throw new YouPetActionRequestCoreError({
          status: 422,
          path: "/api/v1/action-requests",
          code: "invalid_cursor",
        });
      }
      if (params.approvalState === "approved" && params.executionState === "queued") {
        return { items: [structuredClone(options.queued)], nextCursor: null };
      }
      if (params.approvalState === "approved" && params.executionState === "not_started") {
        if (params.cursor === "cursor-deep") {
          return { items: [structuredClone(options.deep)], nextCursor: null };
        }
        return { items: [structuredClone(options.head)], nextCursor: "cursor-deep" };
      }
      return { items: [], nextCursor: null };
    },
    async get(actionRequestId: string) {
      return await coreFor(actionRequestId).get(actionRequestId);
    },
    async claimExecution(params: Parameters<YouPetActionRequestClient["claimExecution"]>[0]) {
      return await coreFor(params.actionRequestId).claimExecution(params);
    },
    async updateExecution(params: Parameters<YouPetActionRequestClient["updateExecution"]>[0]) {
      return await coreFor(params.actionRequestId).updateExecution(params);
    },
  };
}

function createNewestFirstCatalog(initial: YouPetActionRequestEnvelope[]) {
  let highSeq = initial.length;
  let items = initial.map((item, index) => ({ seq: highSeq - index, item }));
  return {
    prepend(next: YouPetActionRequestEnvelope[]) {
      highSeq += next.length;
      items = [...next.map((item, index) => ({ seq: highSeq - index, item })), ...items];
    },
    remove(actionRequestId: string) {
      items = items.filter((entry) => entry.item.action_request.id !== actionRequestId);
    },
    list(cursor?: string): CursorListPage {
      const afterSeq = cursor
        ? Number(cursor.replace(/^after-seq:/u, ""))
        : Number.POSITIVE_INFINITY;
      const eligible = items
        .filter((entry) => entry.seq < afterSeq)
        .toSorted((left, right) => right.seq - left.seq);
      const page = eligible.slice(0, 200);
      const last = page.at(-1);
      return {
        items: page.map((entry) => structuredClone(entry.item)),
        nextCursor: eligible.length > page.length && last ? `after-seq:${last.seq}` : null,
      };
    },
  };
}

function createEnvelope(
  overrides: {
    requestId?: string;
    proposerId?: string;
    targetId?: string;
    approvalState?: string;
    executionState?: string;
    executionClaimOwnerId?: string | null;
    executionClaimLeaseExpiresAt?: string | null;
    policyOutcome?: string;
    requiredApproverClass?: string | null;
    risk?: string;
    policyExpiresAt?: string;
    rowVersion?: number;
  } = {},
): YouPetActionRequestEnvelope {
  const requestId = overrides.requestId ?? REQUEST_ID;
  const targetId = overrides.targetId ?? TASK_ID;
  return {
    action_request: {
      id: requestId,
      tenant_id: TENANT_ID,
      proposer: { type: "agent", id: overrides.proposerId ?? ACTOR_ID },
      target: { type: "task_instance", id: targetId },
      action_type: "task.escalate",
      risk: overrides.risk ?? "high",
      payload: {
        mode: "inline",
        fields: {
          task_id: targetId,
          severity: "medium",
          summary: "Task missed the configured YouPet check-in threshold.",
        },
      },
      policy: {
        outcome: overrides.policyOutcome ?? "require_approval",
        ...(overrides.requiredApproverClass === undefined && overrides.policyOutcome !== "allow"
          ? { required_approver_class: "operator" }
          : overrides.requiredApproverClass
            ? { required_approver_class: overrides.requiredApproverClass }
            : {}),
        ...(overrides.policyExpiresAt ? { expires_at: overrides.policyExpiresAt } : {}),
      },
      approval: { state: overrides.approvalState ?? "approved" },
      execution: { state: overrides.executionState ?? "not_started" },
      links: { domain_event_ids: ["evt-task-missed-1"] },
      correlation_id: "corr-task-1",
      created_at: "2026-08-09T01:00:00Z",
      updated_at: "2026-08-09T01:30:00Z",
    },
    row_version: overrides.rowVersion ?? 1,
    execution_claim:
      overrides.executionClaimOwnerId && overrides.executionClaimLeaseExpiresAt
        ? {
            owner_id: overrides.executionClaimOwnerId,
            lease_expires_at: overrides.executionClaimLeaseExpiresAt,
          }
        : null,
  };
}

class FakeActionRequestCore {
  private state: { values: Map<string, YouPetActionRequestEnvelope> };
  private readonly primaryRequestId: string;
  private readonly frozenList: YouPetActionRequestEnvelope | undefined;
  private readonly includeRegardlessOfFilters: boolean;
  private readonly listPages: Partial<Record<string, YouPetActionRequestEnvelope[][]>>;
  readonly updates: Array<{
    update: YouPetActionRequestExecutionUpdate;
    idempotencyKey: string;
  }> = [];
  readonly updateAttempts: Array<{
    update: YouPetActionRequestExecutionUpdate;
    idempotencyKey: string;
  }> = [];
  readonly claims: Array<{
    claim: { worker_id: string; expected_row_version: number };
    idempotencyKey: string;
  }> = [];
  readonly listRequests: Array<{
    approvalState: string;
    executionState: string;
    cursor: string | undefined;
  }> = [];

  constructor(
    envelope: YouPetActionRequestEnvelope,
    options: {
      frozenList?: YouPetActionRequestEnvelope;
      includeRegardlessOfFilters?: boolean;
      listPages?: Partial<Record<string, YouPetActionRequestEnvelope[][]>>;
      now?: () => Date;
    } = {},
  ) {
    this.primaryRequestId = envelope.action_request.id;
    this.state = {
      values: new Map(
        collectFakeStateEnvelopes(envelope, options).map((item) => [
          item.action_request.id,
          structuredClone(item),
        ]),
      ),
    };
    this.frozenList = options.frozenList;
    this.includeRegardlessOfFilters = options.includeRegardlessOfFilters ?? false;
    this.listPages = options.listPages ?? {};
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  shareStateWith(other: FakeActionRequestCore): void {
    this.state = other.state;
  }

  async get(actionRequestId = this.primaryRequestId): Promise<YouPetActionRequestEnvelope> {
    return structuredClone(this.requireState(actionRequestId));
  }

  async list(params: {
    approvalState: string;
    executionState: string;
    cursor?: string;
  }): Promise<{ items: YouPetActionRequestEnvelope[]; nextCursor: string | null }> {
    this.listRequests.push({
      approvalState: params.approvalState,
      executionState: params.executionState,
      cursor: params.cursor,
    });
    const bucketKey = `${params.approvalState}:${params.executionState}`;
    const bucketPages = this.listPages[bucketKey];
    if (bucketPages) {
      const pageIndex = params.cursor ? Number(params.cursor.split(":").at(-1)) : 0;
      const items = bucketPages[pageIndex] ?? [];
      return {
        items: structuredClone(items),
        nextCursor: pageIndex + 1 < bucketPages.length ? `${bucketKey}:${pageIndex + 1}` : null,
      };
    }
    const source = this.frozenList ?? this.requireState(this.primaryRequestId);
    if (
      this.includeRegardlessOfFilters ||
      (source.action_request.approval.state === params.approvalState &&
        source.action_request.execution.state === params.executionState)
    ) {
      return { items: [structuredClone(source)], nextCursor: null };
    }
    return { items: [], nextCursor: null };
  }

  async updateExecution(params: {
    actionRequestId?: string;
    update: YouPetActionRequestExecutionUpdate;
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    const actionRequestId = params.actionRequestId ?? this.primaryRequestId;
    const current = this.requireState(actionRequestId);
    this.updateAttempts.push({ update: params.update, idempotencyKey: params.idempotencyKey });
    if (params.update.expected_row_version !== current.row_version) {
      throw new YouPetActionRequestCoreError({
        status: 409,
        path: "/execution-status",
        code: "concurrency_conflict",
      });
    }
    if (
      current.action_request.execution.state === "running" &&
      ["succeeded", "failed", "cancelled"].includes(params.update.state)
    ) {
      const owner =
        typeof current.execution_claim?.owner_id === "string" &&
        current.execution_claim.owner_id.length > 0
          ? current.execution_claim.owner_id
          : null;
      const leaseExpiresAt =
        typeof current.execution_claim?.lease_expires_at === "string" &&
        current.execution_claim.lease_expires_at.length > 0
          ? current.execution_claim.lease_expires_at
          : null;
      const isExpiredAuthorizationRecovery =
        (params.update.state === "failed" || params.update.state === "cancelled") &&
        params.update.error?.code === "execution_authorization_expired" &&
        hasRecoverableFakePolicyExpiry(current.action_request.policy.expires_at, this.now());
      const hasExpiredOrLegacyLease =
        (!owner && !leaseExpiresAt) ||
        (owner !== null &&
          leaseExpiresAt !== null &&
          Number.isFinite(new Date(leaseExpiresAt).valueOf()) &&
          new Date(leaseExpiresAt) <= this.now());
      const hasLiveOwnedLease =
        owner !== null &&
        leaseExpiresAt !== null &&
        params.update.worker_id === owner &&
        new Date(leaseExpiresAt) > this.now();
      if (isExpiredAuthorizationRecovery && params.update.worker_id && hasExpiredOrLegacyLease) {
        throw new YouPetActionRequestCoreError({
          status: 409,
          path: "/execution-status",
          code: "invalid_execution_body",
        });
      }
      if (isExpiredAuthorizationRecovery && !params.update.worker_id && hasExpiredOrLegacyLease) {
        if (params.update.result) {
          throw new YouPetActionRequestCoreError({
            status: 409,
            path: "/execution-status",
            code: "invalid_execution_body",
          });
        }
        this.updates.push({ update: params.update, idempotencyKey: params.idempotencyKey });
        const next = {
          ...current,
          action_request: {
            ...current.action_request,
            execution: { state: params.update.state },
            updated_at: "2026-08-09T01:31:00Z",
          },
          execution_claim: null,
          row_version: current.row_version + 1,
        };
        this.state.values.set(actionRequestId, next);
        return structuredClone(next);
      }
      if (isExpiredAuthorizationRecovery && hasLiveOwnedLease) {
        this.updates.push({ update: params.update, idempotencyKey: params.idempotencyKey });
        const next = {
          ...current,
          action_request: {
            ...current.action_request,
            execution: { state: params.update.state },
            updated_at: "2026-08-09T01:31:00Z",
          },
          execution_claim: null,
          row_version: current.row_version + 1,
        };
        this.state.values.set(actionRequestId, next);
        return structuredClone(next);
      }
      if (!owner || !leaseExpiresAt || !params.update.worker_id) {
        throw new YouPetActionRequestCoreError({
          status: 409,
          path: "/execution-status",
          code: "execution_claim_required",
        });
      }
      if (params.update.worker_id !== owner) {
        throw new YouPetActionRequestCoreError({
          status: 409,
          path: "/execution-status",
          code: "execution_lease_not_owner",
        });
      }
      if (new Date(leaseExpiresAt) <= this.now()) {
        throw new YouPetActionRequestCoreError({
          status: 409,
          path: "/execution-status",
          code: "execution_lease_expired",
        });
      }
    }
    this.updates.push({ update: params.update, idempotencyKey: params.idempotencyKey });
    const next = {
      ...current,
      action_request: {
        ...current.action_request,
        execution: { state: params.update.state },
        updated_at: "2026-08-09T01:31:00Z",
      },
      execution_claim: ["succeeded", "failed", "cancelled"].includes(params.update.state)
        ? null
        : current.execution_claim,
      row_version: current.row_version + 1,
    };
    this.state.values.set(actionRequestId, next);
    return structuredClone(next);
  }

  async claimExecution(params: {
    actionRequestId?: string;
    claim: { worker_id: string; expected_row_version: number };
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    const actionRequestId = params.actionRequestId ?? this.primaryRequestId;
    const current = this.requireState(actionRequestId);
    if (params.claim.expected_row_version !== current.row_version) {
      throw new YouPetActionRequestCoreError({
        status: 409,
        path: "/execution-claim",
        code: "concurrency_conflict",
      });
    }
    const currentState = current.action_request.execution.state;
    const currentOwner = current.execution_claim?.owner_id ?? null;
    const currentExpiry = current.execution_claim?.lease_expires_at ?? null;
    const activeOwner =
      currentOwner && currentExpiry && new Date(currentExpiry) > this.now() ? currentOwner : null;
    if (currentState !== "queued" && currentState !== "running") {
      throw new Error("test fake only supports queued/running claims");
    }
    if (activeOwner && activeOwner !== params.claim.worker_id) {
      throw new YouPetActionRequestCoreError({
        status: 409,
        path: "/execution-claim",
        code: "execution_lease_conflict",
      });
    }
    this.claims.push({ claim: params.claim, idempotencyKey: params.idempotencyKey });
    const next = {
      ...current,
      action_request: {
        ...current.action_request,
        execution: { state: "running" },
        updated_at: "2026-08-09T01:31:00Z",
      },
      execution_claim: {
        owner_id: params.claim.worker_id,
        lease_expires_at: new Date(this.now().valueOf() + 5 * 60_000).toISOString(),
      },
      row_version: current.row_version + 1,
    };
    this.state.values.set(actionRequestId, next);
    return structuredClone(next);
  }

  private requireState(actionRequestId: string): YouPetActionRequestEnvelope {
    const current = this.state.values.get(actionRequestId);
    if (!current) {
      throw new Error(`missing test ActionRequest state for ${actionRequestId}`);
    }
    return current;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nthUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function collectFakeStateEnvelopes(
  envelope: YouPetActionRequestEnvelope,
  options: {
    frozenList?: YouPetActionRequestEnvelope;
    listPages?: Partial<Record<string, YouPetActionRequestEnvelope[][]>>;
  },
): YouPetActionRequestEnvelope[] {
  const collected = new Map<string, YouPetActionRequestEnvelope>();
  const remember = (item: YouPetActionRequestEnvelope | undefined) => {
    if (item) {
      collected.set(item.action_request.id, item);
    }
  };
  remember(envelope);
  remember(options.frozenList);
  for (const pages of Object.values(options.listPages ?? {})) {
    for (const page of pages ?? []) {
      for (const item of page) {
        remember(item);
      }
    }
  }
  return [...collected.values()];
}

function hasRecoverableFakePolicyExpiry(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = new Date(expiresAt);
  return Number.isFinite(parsed.valueOf()) && parsed <= now;
}

function expectCursorStoreFault(operation: CursorFaultOperation): void {
  const params = {
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    approvalState: "approved" as const,
    executionState: "not_started" as const,
  };
  const cursorStore = createYouPetActionRequestCursorStore({
    lookup() {
      throw new Error("boom-load");
    },
    register() {
      throw new Error("boom-save");
    },
    registerIfAbsent() {
      return false;
    },
    update() {
      return false;
    },
    consume() {
      return undefined;
    },
    delete() {
      throw new Error("boom-clear");
    },
    entries() {
      return [];
    },
    clear() {},
  } as ReturnType<typeof createPluginStateSyncKeyedStoreForTests>);
  try {
    if (operation === "load") {
      cursorStore.load(params);
    } else if (operation === "save") {
      cursorStore.save({ ...params, nextCursor: "cursor-1" });
    } else {
      cursorStore.clear(params);
    }
    throw new Error("expected cursor store operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(YouPetActionRequestCursorStoreError);
    expect(error).toMatchObject({
      name: "YouPetActionRequestCursorStoreError",
      operation,
      sliceKey: toYouPetActionRequestCursorKey(params),
    });
  }
}

function createCoreBackedClient(
  validCore: FakeActionRequestCore,
  list: (params: {
    approvalState: string;
    executionState: string;
    cursor?: string;
  }) => Promise<CursorListPage>,
) {
  return {
    list,
    async get(actionRequestId: string) {
      return await validCore.get(actionRequestId);
    },
    async claimExecution(params: Parameters<FakeActionRequestCore["claimExecution"]>[0]) {
      return await validCore.claimExecution(params);
    },
    async updateExecution(params: Parameters<FakeActionRequestCore["updateExecution"]>[0]) {
      return await validCore.updateExecution(params);
    },
  };
}

async function executeSuccessfulMutation(): Promise<{
  kind: "succeeded";
  result: { outcome_code: "ok" };
}> {
  return { kind: "succeeded", result: { outcome_code: "ok" } };
}

async function runCursorSliceIsolationCase(options: {
  operation: CursorFaultOperation;
  requestId: number;
  page: CursorListPage;
}): Promise<{
  result: Awaited<ReturnType<YouPetActionRequestDispatcher["dispatchOnce"]>>;
  validCore: FakeActionRequestCore;
  logger: { error: ReturnType<typeof vi.fn> };
}> {
  const valid = createEnvelope({ requestId: nthUuid(options.requestId) });
  const validCore = new FakeActionRequestCore(valid);
  const logger = { error: vi.fn() };
  const dispatcher = new YouPetActionRequestDispatcher({
    client: createSliceIsolationClient(validCore, {
      "approved:queued": options.page,
      "approved:not_started": { items: [structuredClone(valid)], nextCursor: null },
    }),
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    workerId: "worker-a",
    executeMutation: executeSuccessfulMutation,
    cursorStore: createFaultingCursorStore({ [options.operation]: ["approved:queued"] }),
    logger,
  });
  return {
    result: await dispatcher.dispatchOnce(),
    validCore,
    logger,
  };
}

async function dispatchDeepBacklogOnce(options: {
  validCore: FakeActionRequestCore;
  valid: YouPetActionRequestEnvelope;
  requests: Array<string | undefined>;
  cursorStore: YouPetActionRequestCursorStore;
}): Promise<Awaited<ReturnType<YouPetActionRequestDispatcher["dispatchOnce"]>>> {
  return await new YouPetActionRequestDispatcher({
    client: createDeepBacklogClient(options.validCore, options.valid, options.requests),
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    workerId: "worker-a",
    executeMutation: executeSuccessfulMutation,
    cursorStore: options.cursorStore,
  }).dispatchOnce();
}

function createSliceIsolationClient(
  validCore: FakeActionRequestCore,
  pages: Partial<Record<CursorSliceKey, CursorListPage>>,
) {
  return createCoreBackedClient(validCore, async (params) => {
    const page = pages[`${params.approvalState}:${params.executionState}` as CursorSliceKey];
    if (!page || params.cursor) {
      return { items: [], nextCursor: null };
    }
    return {
      items: structuredClone(page.items),
      nextCursor: page.nextCursor,
    };
  });
}

function createDeepBacklogClient(
  validCore: FakeActionRequestCore,
  valid: YouPetActionRequestEnvelope,
  requests: Array<string | undefined>,
) {
  return createCoreBackedClient(validCore, async (params) => {
    if (params.approvalState !== "approved" || params.executionState !== "not_started") {
      return { items: [], nextCursor: null };
    }
    requests.push(params.cursor);
    const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
    if (pageIndex < 200) {
      return {
        items: [
          createEnvelope({
            requestId: nthUuid(70_000 + pageIndex),
            proposerId: `foreign-agent-${pageIndex}`,
          }),
        ],
        nextCursor: `cursor-${pageIndex + 1}`,
      };
    }
    return { items: [structuredClone(valid)], nextCursor: null };
  });
}

function createFaultingCursorStore(
  faults: Partial<Record<CursorFaultOperation, CursorSliceKey[]>>,
  options: { delegate?: YouPetActionRequestCursorStore; once?: boolean } = {},
): YouPetActionRequestCursorStore {
  const delegate = options.delegate ?? createMapBackedCursorStore();
  const triggered = new Set<string>();
  const shouldFault = (
    operation: CursorFaultOperation,
    params: {
      approvalState: "approved" | "not_required";
      executionState: "running" | "queued" | "not_started";
    },
  ): boolean => {
    const slice = `${params.approvalState}:${params.executionState}` as CursorSliceKey;
    if (!faults[operation]?.includes(slice)) {
      return false;
    }
    const key = `${operation}:${slice}`;
    if (!options.once) {
      return true;
    }
    if (triggered.has(key)) {
      return false;
    }
    triggered.add(key);
    return true;
  };
  const throwFault = (
    operation: CursorFaultOperation,
    params: Parameters<typeof toYouPetActionRequestCursorKey>[0],
  ): never => {
    throw new YouPetActionRequestCursorStoreError({
      cause: new Error(`forced ${operation} fault`),
      operation,
      sliceKey: toYouPetActionRequestCursorKey(params),
    });
  };

  return {
    load(params) {
      if (shouldFault("load", params)) {
        return throwFault("load", params);
      }
      return delegate.load(params);
    },
    save(params) {
      if (shouldFault("save", params)) {
        return throwFault("save", params);
      }
      return delegate.save(params);
    },
    clear(params) {
      if (shouldFault("clear", params)) {
        return throwFault("clear", params);
      }
      return delegate.clear(params);
    },
  };
}

function createMapBackedCursorStore(): YouPetActionRequestCursorStore {
  const map = new Map<string, string>();
  return {
    load(params) {
      return map.get(toYouPetActionRequestCursorKey(params));
    },
    save(params) {
      map.set(toYouPetActionRequestCursorKey(params), params.nextCursor);
    },
    clear(params) {
      map.delete(toYouPetActionRequestCursorKey(params));
    },
  };
}

function createTestCursorStore(env: Record<string, string | undefined>) {
  return createYouPetActionRequestCursorStore(
    createPluginStateSyncKeyedStoreForTests("youpet", {
      namespace: YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE,
      maxEntries: YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
      env,
    }),
  );
}
