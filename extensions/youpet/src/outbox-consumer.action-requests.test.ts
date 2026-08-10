import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
} from "../test/flow-store.fixture.js";
import { actionRequestEnvelopeFromCreate } from "../test/outbox-consumer.fixture.js";
import {
  buildYouPetActionRequestProposal,
  type YouPetActionRequestExecutionClaimRequest,
  type YouPetActionRequestEnvelope,
  type YouPetActionRequestExecutionUpdate,
} from "./action-request-routing.js";
import { YouPetOutboxConsumer, type YouPetOutboxFetch } from "./outbox-consumer.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";
const TASK_ID = "00000000-0000-4000-8000-000000000201";
const PLAN_ID = "00000000-0000-4000-8000-000000000301";
const ACTOR_ID = "openclaw-youpet-consumer";

type CapturedRequest = {
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
};

type MutationResponse = { status: number; body: unknown } | { error: Error };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createDispatchCore(params: {
  envelope: YouPetActionRequestEnvelope;
  mutationPath: string;
  mutationResponse: MutationResponse;
  now?: () => Date;
  executionFailure?: {
    state: YouPetActionRequestExecutionUpdate["state"];
    response: MutationResponse;
  };
}) {
  let current = structuredClone(params.envelope);
  const now = params.now ?? (() => new Date());
  const requests: CapturedRequest[] = [];
  const fetchFn: YouPetOutboxFetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({
      path: `${url.pathname}${url.search}`,
      method,
      headers: new Headers(init?.headers),
      body,
    });

    if (url.pathname === "/api/v1/action-requests" && method === "GET") {
      const matches =
        url.searchParams.get("tenant_id") === current.action_request.tenant_id &&
        url.searchParams.get("approval_state") === current.action_request.approval.state &&
        url.searchParams.get("execution_state") === current.action_request.execution.state;
      return jsonResponse({ items: matches ? [current] : [], count: matches ? 1 : 0 });
    }
    if (
      url.pathname === `/api/v1/action-requests/${current.action_request.id}` &&
      method === "GET"
    ) {
      return jsonResponse(current);
    }
    if (
      url.pathname === `/api/v1/action-requests/${current.action_request.id}/execution-claim` &&
      method === "POST"
    ) {
      const claim = body as unknown as YouPetActionRequestExecutionClaimRequest;
      if (claim.expected_row_version !== current.row_version) {
        return jsonResponse(
          { detail: { code: "concurrency_conflict", message: "stale row version" } },
          409,
        );
      }
      const activeOwner =
        current.execution_claim && new Date(current.execution_claim.lease_expires_at) > now()
          ? current.execution_claim.owner_id
          : null;
      if (activeOwner && activeOwner !== claim.worker_id) {
        return jsonResponse(
          { detail: { code: "execution_lease_conflict", message: "owned by another worker" } },
          409,
        );
      }
      current = {
        action_request: {
          ...current.action_request,
          execution: { state: "running" },
          updated_at: "2026-08-10T02:00:01Z",
        },
        row_version: current.row_version + 1,
        execution_claim: {
          owner_id: claim.worker_id,
          lease_expires_at: new Date(now().valueOf() + 5 * 60_000).toISOString(),
        },
      };
      return jsonResponse(current);
    }
    if (
      url.pathname === `/api/v1/action-requests/${current.action_request.id}/execution-status` &&
      method === "POST"
    ) {
      const update = body as unknown as YouPetActionRequestExecutionUpdate;
      if (params.executionFailure?.state === update.state) {
        const failure = params.executionFailure.response;
        if ("error" in failure) {
          throw failure.error;
        }
        return jsonResponse(failure.body, failure.status);
      }
      if (update.expected_row_version !== current.row_version) {
        return jsonResponse(
          { detail: { code: "concurrency_conflict", message: "stale row version" } },
          409,
        );
      }
      if (update.state === "running") {
        return jsonResponse(
          {
            detail: {
              code: "execution_claim_required",
              message: "running execution must be entered through the execution-claim command",
            },
          },
          409,
        );
      }
      if (
        current.action_request.execution.state === "running" &&
        ["succeeded", "failed", "cancelled"].includes(update.state)
      ) {
        const owner = current.execution_claim?.owner_id;
        const expiry = current.execution_claim?.lease_expires_at;
        if (!owner || !expiry || !update.worker_id) {
          return jsonResponse(
            { detail: { code: "execution_claim_required", message: "missing owner" } },
            409,
          );
        }
        if (update.worker_id !== owner) {
          return jsonResponse(
            { detail: { code: "execution_lease_not_owner", message: "wrong owner" } },
            409,
          );
        }
        if (new Date(expiry) <= now()) {
          return jsonResponse(
            { detail: { code: "execution_lease_expired", message: "expired" } },
            409,
          );
        }
      }
      current = {
        action_request: {
          ...current.action_request,
          execution: { state: update.state },
          updated_at: "2026-08-09T02:00:01Z",
        },
        execution_claim: ["succeeded", "failed", "cancelled"].includes(update.state)
          ? null
          : current.execution_claim,
        row_version: current.row_version + 1,
      };
      return jsonResponse(current);
    }
    if (url.pathname === params.mutationPath && method === "POST") {
      if ("error" in params.mutationResponse) {
        throw params.mutationResponse.error;
      }
      return jsonResponse(params.mutationResponse.body, params.mutationResponse.status);
    }
    return jsonResponse({ detail: { code: "not_found", message: url.pathname } }, 404);
  };
  return { fetchFn, requests, current: () => current };
}

function createAuthorizedEnvelope(
  routeId: "task-escalate" | "health-plan-flow-link",
  flowId = "flow-1",
): YouPetActionRequestEnvelope {
  const proposal =
    routeId === "task-escalate"
      ? buildYouPetActionRequestProposal({
          routeId,
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          sourceEventId: "event-task-missed",
          sourceOccurredAt: "2026-08-09T01:00:00Z",
          correlationId: "corr-task",
          targetId: TASK_ID,
          payloadFields: {
            task_id: TASK_ID,
            severity: "medium",
            summary: "Task missed the configured YouPet check-in threshold.",
          },
        })
      : buildYouPetActionRequestProposal({
          routeId,
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          sourceEventId: "event-plan-activated",
          sourceOccurredAt: "2026-08-09T01:00:00Z",
          correlationId: "corr-flow",
          targetId: PLAN_ID,
          payloadFields: {
            health_plan_id: PLAN_ID,
            openclaw_flow_id: flowId,
          },
        });
  const envelope = actionRequestEnvelopeFromCreate(proposal.request);
  envelope.execution_claim ??= null;
  if (routeId === "task-escalate") {
    envelope.action_request.approval = { state: "approved" };
  }
  return envelope;
}

afterEach(async () => {
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPet ActionRequest mutation dispatch", () => {
  it("CAS-claims an allowed flow link, executes it once, and marks the local flow linked", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const flow = flowStore.recordHealthPlanActivated({
      eventId: "event-plan-activated",
      eventType: "health_plan.activated",
      aggregateId: PLAN_ID,
      planId: PLAN_ID,
      correlationId: null,
    });
    const core = createDispatchCore({
      envelope: createAuthorizedEnvelope("health-plan-flow-link", flow.flow_id),
      mutationPath: `/api/v1/health-plans/${PLAN_ID}/flow`,
      mutationResponse: { status: 200, body: { openclaw_flow_id: flow.flow_id } },
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      workerId: "worker-a",
      fetchFn: core.fetchFn,
      flowStore,
    });

    const result = await consumer.dispatchActionRequestsOnce();

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(core.current()).toMatchObject({
      action_request: { execution: { state: "succeeded" } },
      row_version: 4,
    });
    expect(flowStore.lookupFlowByPlanId(PLAN_ID)?.core_linked).toBe(true);
    const mutation = core.requests.find((request) => request.path.endsWith("/flow"));
    expect(mutation).toMatchObject({
      method: "POST",
      body: { openclaw_flow_id: flow.flow_id },
    });
    expect(mutation?.headers.get("idempotency-key")).toMatch(
      /^openclaw\.youpet\.mutation\.[0-9a-f]{64}$/u,
    );
    expect(
      core.requests
        .filter((request) => request.path.endsWith("/execution-status"))
        .map((request) => request.body?.state),
    ).toEqual(["queued", "succeeded"]);
    expect(
      core.requests
        .filter((request) => request.path.endsWith("/execution-claim"))
        .map((request) => request.body),
    ).toEqual([{ worker_id: "worker-a", expected_row_version: 2 }]);
    expect(
      core.requests.find(
        (request) =>
          request.path.endsWith("/execution-status") && request.body?.state === "succeeded",
      )?.body,
    ).toMatchObject({ worker_id: "worker-a" });
  });

  it("treats an exact matching flow conflict as idempotent terminal success", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const flow = flowStore.recordHealthPlanActivated({
      eventId: "event-plan-activated",
      eventType: "health_plan.activated",
      aggregateId: PLAN_ID,
      planId: PLAN_ID,
      correlationId: null,
    });
    const core = createDispatchCore({
      envelope: createAuthorizedEnvelope("health-plan-flow-link", flow.flow_id),
      mutationPath: `/api/v1/health-plans/${PLAN_ID}/flow`,
      mutationResponse: {
        status: 409,
        body: {
          detail: {
            code: "flow_id_conflict",
            current_flow_id: flow.flow_id,
            attempted_flow_id: flow.flow_id,
          },
        },
      },
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-a",
      fetchFn: core.fetchFn,
      flowStore,
    });

    const result = await consumer.dispatchActionRequestsOnce();

    expect(result).toMatchObject({ failed: 0, succeeded: 1, retried: 0 });
    expect(core.current().action_request.execution.state).toBe("succeeded");
    expect(flowStore.lookupFlowByPlanId(PLAN_ID)?.core_linked).toBe(true);
  });

  it("fails a flow conflict whose current value does not match the intended flow", async () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    const flow = flowStore.recordHealthPlanActivated({
      eventId: "event-plan-activated",
      eventType: "health_plan.activated",
      aggregateId: PLAN_ID,
      planId: PLAN_ID,
      correlationId: null,
    });
    const core = createDispatchCore({
      envelope: createAuthorizedEnvelope("health-plan-flow-link", flow.flow_id),
      mutationPath: `/api/v1/health-plans/${PLAN_ID}/flow`,
      mutationResponse: {
        status: 409,
        body: {
          detail: {
            code: "flow_id_conflict",
            current_flow_id: "different-flow",
            attempted_flow_id: flow.flow_id,
          },
        },
      },
    });
    const consumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-a",
      fetchFn: core.fetchFn,
      flowStore,
    });

    const result = await consumer.dispatchActionRequestsOnce();

    expect(result).toMatchObject({ failed: 1, succeeded: 0, retried: 0 });
    expect(core.current().action_request.execution.state).toBe("failed");
    expect(flowStore.lookupFlowByPlanId(PLAN_ID)?.core_linked).toBe(false);
  });

  it.each(["escalated", "completed"])(
    "fails task invalid-state current_status=%s because status alone cannot prove this request's mutation",
    async (currentStatus) => {
      const core = createDispatchCore({
        envelope: createAuthorizedEnvelope("task-escalate"),
        mutationPath: `/api/v1/tasks/${TASK_ID}/escalate`,
        mutationResponse: {
          status: 409,
          body: {
            detail: {
              code: "invalid_task_state",
              current_status: currentStatus,
              allowed_statuses: ["pending", "reminded", "missed"],
            },
          },
        },
      });
      const consumer = new YouPetOutboxConsumer({
        coreBaseUrl: "https://core.example.com",
        serviceToken: "svc-token",
        tenantId: TENANT_ID,
        workerId: "worker-a",
        fetchFn: core.fetchFn,
      });

      const result = await consumer.dispatchActionRequestsOnce();

      expect(result).toMatchObject({ succeeded: 0, failed: 1, retried: 0 });
      expect(core.current().action_request.execution.state).toBe("failed");
    },
  );

  it("blocks a different worker until lease expiry, then reuses the same downstream mutation key", async () => {
    const envelope = createAuthorizedEnvelope("task-escalate");
    const firstNow = new Date();
    const first = createDispatchCore({
      envelope,
      mutationPath: `/api/v1/tasks/${TASK_ID}/escalate`,
      mutationResponse: { status: 500, body: { detail: { code: "core_error" } } },
      now: () => firstNow,
    });
    const firstConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-before-restart",
      fetchFn: first.fetchFn,
    });

    expect(await firstConsumer.dispatchActionRequestsOnce()).toMatchObject({ retried: 1 });
    expect(first.current().action_request.execution.state).toBe("running");
    const firstKey = first.requests
      .find((request) => request.path.endsWith("/escalate"))
      ?.headers.get("idempotency-key");
    const firstLeaseExpiry = first.current().execution_claim?.lease_expires_at;

    const second = createDispatchCore({
      envelope: first.current(),
      mutationPath: `/api/v1/tasks/${TASK_ID}/escalate`,
      mutationResponse: { status: 201, body: { id: "alert-1", status: "open" } },
      now: () => firstNow,
    });
    const secondConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-after-restart",
      fetchFn: second.fetchFn,
    });
    expect(await secondConsumer.dispatchActionRequestsOnce()).toMatchObject({
      conflicted: 1,
      succeeded: 0,
    });
    expect(second.requests.find((request) => request.path.endsWith("/escalate"))).toBeUndefined();

    const third = createDispatchCore({
      envelope: first.current(),
      mutationPath: `/api/v1/tasks/${TASK_ID}/escalate`,
      mutationResponse: { status: 201, body: { id: "alert-1", status: "open" } },
      now: () => new Date(new Date(firstLeaseExpiry ?? firstNow.toISOString()).valueOf() + 1_000),
    });
    const thirdConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-after-restart",
      fetchFn: third.fetchFn,
    });

    expect(await thirdConsumer.dispatchActionRequestsOnce()).toMatchObject({ succeeded: 1 });
    const secondKey = second.requests
      .find((request) => request.path.endsWith("/escalate"))
      ?.headers.get("idempotency-key");
    const thirdKey = third.requests
      .find((request) => request.path.endsWith("/escalate"))
      ?.headers.get("idempotency-key");
    expect(secondKey).toBeUndefined();
    expect(thirdKey).toBe(firstKey);
  });

  it("replays a successful mutation with the same key when terminal status persistence fails", async () => {
    const envelope = createAuthorizedEnvelope("task-escalate");
    const first = createDispatchCore({
      envelope,
      mutationPath: `/api/v1/tasks/${TASK_ID}/escalate`,
      mutationResponse: { status: 201, body: { id: "alert-1", status: "open" } },
      executionFailure: {
        state: "succeeded",
        response: { status: 500, body: { detail: { code: "core_error" } } },
      },
    });
    const firstConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-before-restart",
      fetchFn: first.fetchFn,
    });

    await expect(firstConsumer.dispatchActionRequestsOnce()).rejects.toThrow(/execution-status/u);
    expect(first.current().action_request.execution.state).toBe("running");
    const firstKey = first.requests
      .find((request) => request.path.endsWith("/escalate"))
      ?.headers.get("idempotency-key");
    const firstLeaseExpiry = first.current().execution_claim?.lease_expires_at;

    const second = createDispatchCore({
      envelope: first.current(),
      mutationPath: `/api/v1/tasks/${TASK_ID}/escalate`,
      // Core's downstream idempotency replay returns the original success.
      mutationResponse: { status: 201, body: { id: "alert-1", status: "open" } },
      now: () => new Date(new Date(firstLeaseExpiry ?? new Date().toISOString()).valueOf() + 1_000),
    });
    const secondConsumer = new YouPetOutboxConsumer({
      coreBaseUrl: "https://core.example.com",
      serviceToken: "svc-token",
      tenantId: TENANT_ID,
      workerId: "worker-after-restart",
      fetchFn: second.fetchFn,
    });

    expect(await secondConsumer.dispatchActionRequestsOnce()).toMatchObject({ succeeded: 1 });
    expect(second.current().action_request.execution.state).toBe("succeeded");
    const secondKey = second.requests
      .find((request) => request.path.endsWith("/escalate"))
      ?.headers.get("idempotency-key");
    expect(secondKey).toBe(firstKey);
  });
});
