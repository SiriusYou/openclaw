import { describe, expect, it, vi } from "vitest";
import {
  buildYouPetActionRequestProposal,
  matchActionRequestRoute,
  stableYouPetMutationKey,
  YouPetActionRequestClient,
  YouPetActionRequestCoreError,
  YouPetActionRequestDispatcher,
  YOUPET_ACTION_REQUEST_ROUTES,
  type YouPetActionRequestEnvelope,
  type YouPetActionRequestExecutionUpdate,
} from "./action-request-routing.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";
const TASK_ID = "00000000-0000-4000-8000-000000000201";
const PLAN_ID = "00000000-0000-4000-8000-000000000301";
const REQUEST_ID = "00000000-0000-4000-8000-000000000401";
const ACTOR_ID = "openclaw-youpet-consumer";

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
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
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
        async get(actionRequestId) {
          return await core.get(actionRequestId);
        },
        async claimExecution(params) {
          return await core.claimExecution(params);
        },
        async updateExecution(params) {
          return await core.updateExecution(params);
        },
      },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      executeMutation,
    });

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
      listed: foreignPageCount + 1,
      skipped: foreignPageCount,
      claimed: 1,
      succeeded: 1,
      conflicted: 0,
      errored: 0,
    });
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

  it("resumes from the persisted slice cursor instead of restarting from page one every cycle", async () => {
    const valid = createEnvelope({ requestId: nthUuid(20_200) });
    let firstPageCalls = 0;
    const dispatcher = new YouPetActionRequestDispatcher({
      client: {
        async list(params) {
          if (params.approvalState !== "approved" || params.executionState !== "not_started") {
            return { items: [], nextCursor: null };
          }
          if (!params.cursor) {
            firstPageCalls += 1;
          }
          const pageIndex = params.cursor ? Number(params.cursor.replace("cursor-", "")) : 0;
          if (pageIndex < 250) {
            return {
              items: [
                createEnvelope({
                  requestId: nthUuid(30_000 + pageIndex),
                  proposerId: `foreign-agent-${pageIndex}`,
                }),
              ],
              nextCursor: `cursor-${pageIndex + 1}`,
            };
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
    const validCore = new FakeActionRequestCore(valid);

    const first = await dispatcher.dispatchOnce();
    const second = await dispatcher.dispatchOnce();

    expect(first.succeeded).toBe(0);
    expect(second.succeeded).toBe(1);
    expect(firstPageCalls).toBe(1);
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

    expect(result.failed, JSON.stringify({ result, recoveryAttempts })).toBe(1);
    expect(result).toMatchObject({
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
        !params.update.worker_id &&
        (params.update.state === "failed" || params.update.state === "cancelled") &&
        params.update.error?.code === "execution_authorization_expired" &&
        hasRecoverableFakePolicyExpiry(current.action_request.policy.expires_at, this.now());
      if (
        isExpiredAuthorizationRecovery &&
        ((!owner && !leaseExpiresAt) ||
          (owner !== null &&
            leaseExpiresAt !== null &&
            Number.isFinite(new Date(leaseExpiresAt).valueOf()) &&
            new Date(leaseExpiresAt) <= this.now()))
      ) {
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
