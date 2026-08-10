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
            ? { items: [envelope], count: 1 }
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
      `/api/v1/action-requests/${REQUEST_ID}/execution-status`,
      `/api/v1/action-requests/${REQUEST_ID}/execution-claim`,
      `/api/v1/action-requests/${REQUEST_ID}/execution-status`,
    ]);
    expect(captured.some((entry) => /\/(approve|reject)$/u.test(entry.path))).toBe(false);
    expect(captured[0]?.headers.get("idempotency-key")).toBe(proposal.idempotencyKey);
    expect(captured[3]?.body).toEqual({ state: "queued", expected_row_version: 1 });
    expect(captured[4]?.body).toEqual({ worker_id: "worker-a", expected_row_version: 2 });
    expect(captured[5]?.body).toEqual({
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
        return [structuredClone(running)];
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

  it.each([
    ["pending", "require_approval", undefined],
    ["rejected", "require_approval", undefined],
    ["expired", "require_approval", undefined],
    ["not_required", "deny", undefined],
    ["approved", "require_approval", "2026-08-09T00:00:00Z"],
  ])("fails closed for approval=%s policy=%s", async (approval, policy, expiresAt) => {
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

    expect(await dispatcher.dispatchOnce()).toMatchObject({ skipped: 1, claimed: 0 });
    expect(executeMutation).not.toHaveBeenCalled();
    expect(core.updates).toEqual([]);
  });

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

function createEnvelope(
  overrides: {
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
  return {
    action_request: {
      id: REQUEST_ID,
      tenant_id: TENANT_ID,
      proposer: { type: "agent", id: ACTOR_ID },
      target: { type: "task_instance", id: TASK_ID },
      action_type: "task.escalate",
      risk: overrides.risk ?? "high",
      payload: {
        mode: "inline",
        fields: {
          task_id: TASK_ID,
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
  private state: { value: YouPetActionRequestEnvelope };
  private readonly frozenList: YouPetActionRequestEnvelope | undefined;
  private readonly includeRegardlessOfFilters: boolean;
  readonly updates: Array<{
    update: YouPetActionRequestExecutionUpdate;
    idempotencyKey: string;
  }> = [];
  readonly claims: Array<{
    claim: { worker_id: string; expected_row_version: number };
    idempotencyKey: string;
  }> = [];

  constructor(
    envelope: YouPetActionRequestEnvelope,
    options: {
      frozenList?: YouPetActionRequestEnvelope;
      includeRegardlessOfFilters?: boolean;
      now?: () => Date;
    } = {},
  ) {
    this.state = { value: structuredClone(envelope) };
    this.frozenList = options.frozenList;
    this.includeRegardlessOfFilters = options.includeRegardlessOfFilters ?? false;
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  shareStateWith(other: FakeActionRequestCore): void {
    this.state = other.state;
  }

  async get(): Promise<YouPetActionRequestEnvelope> {
    return structuredClone(this.state.value);
  }

  async list(params: {
    approvalState: string;
    executionState: string;
  }): Promise<YouPetActionRequestEnvelope[]> {
    const source = this.frozenList ?? this.state.value;
    if (
      this.includeRegardlessOfFilters ||
      (source.action_request.approval.state === params.approvalState &&
        source.action_request.execution.state === params.executionState)
    ) {
      return [structuredClone(source)];
    }
    return [];
  }

  async updateExecution(params: {
    update: YouPetActionRequestExecutionUpdate;
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    if (params.update.expected_row_version !== this.state.value.row_version) {
      throw new YouPetActionRequestCoreError({
        status: 409,
        path: "/execution-status",
        code: "concurrency_conflict",
      });
    }
    if (
      this.state.value.action_request.execution.state === "running" &&
      ["succeeded", "failed", "cancelled"].includes(params.update.state)
    ) {
      const owner = this.state.value.execution_claim?.owner_id;
      const leaseExpiresAt = this.state.value.execution_claim?.lease_expires_at;
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
    this.state.value = {
      ...this.state.value,
      action_request: {
        ...this.state.value.action_request,
        execution: { state: params.update.state },
        updated_at: "2026-08-09T01:31:00Z",
      },
      execution_claim: ["succeeded", "failed", "cancelled"].includes(params.update.state)
        ? null
        : this.state.value.execution_claim,
      row_version: this.state.value.row_version + 1,
    };
    return structuredClone(this.state.value);
  }

  async claimExecution(params: {
    claim: { worker_id: string; expected_row_version: number };
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    if (params.claim.expected_row_version !== this.state.value.row_version) {
      throw new YouPetActionRequestCoreError({
        status: 409,
        path: "/execution-claim",
        code: "concurrency_conflict",
      });
    }
    const currentState = this.state.value.action_request.execution.state;
    const currentOwner = this.state.value.execution_claim?.owner_id ?? null;
    const currentExpiry = this.state.value.execution_claim?.lease_expires_at ?? null;
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
    this.state.value = {
      ...this.state.value,
      action_request: {
        ...this.state.value.action_request,
        execution: { state: "running" },
        updated_at: "2026-08-09T01:31:00Z",
      },
      execution_claim: {
        owner_id: params.claim.worker_id,
        lease_expires_at: new Date(this.now().valueOf() + 5 * 60_000).toISOString(),
      },
      row_version: this.state.value.row_version + 1,
    };
    return structuredClone(this.state.value);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
