import { createHash, randomUUID } from "node:crypto";
import type { YouPetActionRequestCursorStore } from "./action-request-cursor-store.js";

export type YouPetActionRequestFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type YouPetActionRequestLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type YouPetActionRequestRouteId = "task-escalate" | "health-plan-flow-link";

export const YOUPET_ACTION_REQUEST_ROUTES = {
  "task-escalate": {
    sourceEventType: "task.missed",
    actionType: "task.escalate",
    targetType: "task_instance",
    risk: "high",
    policyOutcome: "require_approval",
    requiredApproverClass: "operator",
    policyId: "openclaw.youpet.task-missed",
    policyReason: "task_missed_threshold",
    policyObligations: ["human_approval"],
    mutationOperation: "task-escalate",
  },
  "health-plan-flow-link": {
    sourceEventType: "health_plan.activated",
    actionType: "workflow.mutate",
    targetType: "health_plan",
    risk: "low",
    policyOutcome: "allow",
    requiredApproverClass: undefined,
    policyId: "openclaw.youpet.health-plan-flow-link",
    policyReason: "health_plan_flow_link",
    policyObligations: [],
    mutationOperation: "health-plan-flow-link",
  },
} as const satisfies Record<
  YouPetActionRequestRouteId,
  {
    sourceEventType: string;
    actionType: string;
    targetType: string;
    risk: "low" | "medium" | "high" | "critical";
    policyOutcome: "allow" | "deny" | "require_approval";
    requiredApproverClass: "operator" | undefined;
    policyId: string;
    policyReason: string;
    policyObligations: readonly string[];
    mutationOperation: string;
  }
>;

export type YouPetActionRequestCreate = {
  id: string;
  tenant_id: string;
  proposer: { type: "agent"; id: string };
  target: { type: "task_instance" | "health_plan"; id: string };
  action_type: "task.escalate" | "workflow.mutate";
  risk: "low" | "high";
  payload: { mode: "inline"; fields: Record<string, string> };
  policy: {
    decision_id: string;
    outcome: "allow" | "require_approval";
    reasons: string[];
    obligations: string[];
    required_approver_class?: "operator";
    policy_id: string;
    policy_version: "1";
    decided_at: string;
  };
  links: {
    audit_log_ids: [];
    domain_event_ids: [string];
    outbox_delivery_ids: [];
    proposal_event_id: string;
    idempotency_key: string;
  };
  correlation_id?: string;
};

export type YouPetActionRequest = {
  id: string;
  tenant_id: string;
  proposer: { type: string; id: string };
  target: { type: string; id: string };
  action_type: string;
  risk: string;
  payload: { mode: string; fields?: Record<string, unknown> };
  policy: {
    outcome: string;
    required_approver_class?: string | null;
    expires_at?: string | null;
  };
  approval: { state: string };
  execution: { state: string };
  links: { domain_event_ids: string[] };
  correlation_id: string;
  created_at: string;
  updated_at: string;
};

export type YouPetActionRequestExecutionClaim = {
  owner_id: string;
  lease_expires_at: string;
};

export type YouPetActionRequestEnvelope = {
  action_request: YouPetActionRequest;
  row_version: number;
  execution_claim: YouPetActionRequestExecutionClaim | null;
};

export type YouPetActionRequestListPage = {
  items: YouPetActionRequestEnvelope[];
  nextCursor: string | null;
};

export type YouPetActionRequestExecutionState = "not_started" | "queued" | "running";

export type YouPetActionRequestExecutionUpdate = {
  state: "queued" | "succeeded" | "failed" | "cancelled";
  expected_row_version: number;
  worker_id?: string;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type YouPetActionRequestExecutionClaimRequest = {
  worker_id: string;
  expected_row_version: number;
};

export class YouPetActionRequestCoreError extends Error {
  readonly status: number;
  readonly path: string;
  readonly code: string | undefined;

  constructor(params: { status: number; path: string; code?: string }) {
    super(`YouPet Core ActionRequest request failed ${params.status} ${params.path}`);
    this.name = "YouPetActionRequestCoreError";
    this.status = params.status;
    this.path = params.path;
    this.code = params.code;
  }
}

export class YouPetActionRequestClient {
  private readonly coreBaseUrl: string;
  private readonly serviceToken: string;
  private readonly actorId: string;
  private readonly fetchFn: YouPetActionRequestFetch;

  constructor(params: {
    coreBaseUrl: string;
    serviceToken: string;
    actorId: string;
    fetchFn?: YouPetActionRequestFetch;
  }) {
    this.coreBaseUrl = params.coreBaseUrl.replace(/\/+$/u, "");
    this.serviceToken = params.serviceToken;
    this.actorId = params.actorId;
    const fetchFn = params.fetchFn ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error("YouPet ActionRequest client requires fetch");
    }
    this.fetchFn = fetchFn;
  }

  async create(params: {
    request: YouPetActionRequestCreate;
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    return await this.requestEnvelope("/api/v1/action-requests", {
      method: "POST",
      body: params.request,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.request.correlation_id,
    });
  }

  async get(actionRequestId: string): Promise<YouPetActionRequestEnvelope> {
    requireUuid(actionRequestId, "action_request.id");
    return await this.requestEnvelope(
      `/api/v1/action-requests/${encodeURIComponent(actionRequestId)}`,
      { method: "GET" },
    );
  }

  async list(params: {
    tenantId: string;
    approvalState: "approved" | "not_required";
    executionState: YouPetActionRequestExecutionState;
    limit?: number;
    cursor?: string;
  }): Promise<YouPetActionRequestListPage> {
    requireUuid(params.tenantId, "tenant_id");
    const body = await this.requestJson("/api/v1/action-requests", {
      method: "GET",
      query: {
        tenant_id: params.tenantId,
        approval_state: params.approvalState,
        execution_state: params.executionState,
        limit: String(params.limit ?? ACTION_REQUEST_PAGE_LIMIT),
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
    });
    const record = requireRecord(body, "ActionRequest list response");
    if (!Array.isArray(record.items)) {
      throw new Error("ActionRequest list response.items must be an array");
    }
    return {
      items: record.items.map((item) => parseActionRequestEnvelope(item)),
      nextCursor:
        record.next_cursor === null || record.next_cursor === undefined
          ? null
          : requireString(record.next_cursor, "ActionRequest list response.next_cursor"),
    };
  }

  async updateExecution(params: {
    actionRequestId: string;
    update: YouPetActionRequestExecutionUpdate;
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    requireUuid(params.actionRequestId, "action_request.id");
    return await this.requestEnvelope(
      `/api/v1/action-requests/${encodeURIComponent(params.actionRequestId)}/execution-status`,
      {
        method: "POST",
        body: params.update,
        idempotencyKey: params.idempotencyKey,
      },
    );
  }

  async claimExecution(params: {
    actionRequestId: string;
    claim: YouPetActionRequestExecutionClaimRequest;
    idempotencyKey: string;
  }): Promise<YouPetActionRequestEnvelope> {
    requireUuid(params.actionRequestId, "action_request.id");
    return await this.requestEnvelope(
      `/api/v1/action-requests/${encodeURIComponent(params.actionRequestId)}/execution-claim`,
      {
        method: "POST",
        body: params.claim,
        idempotencyKey: params.idempotencyKey,
      },
    );
  }

  private async requestEnvelope(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      idempotencyKey?: string;
      correlationId?: string;
    },
  ): Promise<YouPetActionRequestEnvelope> {
    return parseActionRequestEnvelope(await this.requestJson(path, options));
  }

  private async requestJson(
    path: string,
    options: {
      method: "GET" | "POST";
      query?: Record<string, string>;
      body?: unknown;
      idempotencyKey?: string;
      correlationId?: string;
    },
  ): Promise<unknown> {
    const url = new URL(path, `${this.coreBaseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers = new Headers({
      Authorization: `Bearer ${this.serviceToken}`,
      "X-Actor-Id": this.actorId,
    });
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.idempotencyKey) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    if (options.correlationId) {
      headers.set("X-Correlation-Id", options.correlationId);
    }
    const response = await this.fetchFn(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const decoded = text.length > 0 ? parseJson(text) : undefined;
    if (!response.ok) {
      throw new YouPetActionRequestCoreError({
        status: response.status,
        path,
        code: readCoreErrorCode(decoded),
      });
    }
    return decoded;
  }
}

export function buildYouPetActionRequestProposal(params: {
  routeId: YouPetActionRequestRouteId;
  tenantId: string;
  actorId: string;
  sourceEventId: string;
  sourceOccurredAt: string;
  correlationId?: string | null;
  targetId: string;
  payloadFields: Record<string, string>;
}): { request: YouPetActionRequestCreate; idempotencyKey: string } {
  const route = YOUPET_ACTION_REQUEST_ROUTES[params.routeId];
  requireUuid(params.tenantId, "tenant_id");
  requireUuid(params.targetId, "target.id");
  requireOpaqueId(params.actorId, "proposer.id", 128);
  requireOpaqueId(params.sourceEventId, "links.domain_event_ids", 128);
  if (params.correlationId !== undefined && params.correlationId !== null) {
    requireOpaqueId(params.correlationId, "correlation_id", 128);
  }
  const decidedAt = requireUtcTimestamp(params.sourceOccurredAt, "policy.decided_at");
  const proposalKey = stableKey("proposal", params.tenantId, params.routeId, params.sourceEventId);
  const request = {
    id: deterministicUuid("request", params.tenantId, params.routeId, params.sourceEventId),
    tenant_id: params.tenantId,
    proposer: { type: "agent" as const, id: params.actorId },
    target: {
      type: route.targetType,
      id: params.targetId,
    },
    action_type: route.actionType,
    risk: route.risk,
    payload: { mode: "inline" as const, fields: { ...params.payloadFields } },
    policy: {
      decision_id: deterministicUuid("policy", params.routeId, params.sourceEventId),
      outcome: route.policyOutcome,
      reasons: [route.policyReason],
      obligations: [...route.policyObligations],
      ...(route.requiredApproverClass
        ? { required_approver_class: route.requiredApproverClass }
        : {}),
      policy_id: route.policyId,
      policy_version: "1" as const,
      decided_at: decidedAt,
    },
    links: {
      audit_log_ids: [] as [],
      domain_event_ids: [params.sourceEventId] as [string],
      outbox_delivery_ids: [] as [],
      proposal_event_id: params.sourceEventId,
      idempotency_key: proposalKey,
    },
    ...(params.correlationId ? { correlation_id: params.correlationId } : {}),
  } satisfies YouPetActionRequestCreate;
  validateProposalPayload(request, params.routeId);
  return { request, idempotencyKey: proposalKey };
}

export type YouPetMutationOutcome =
  | { kind: "succeeded"; result: Record<string, unknown> }
  | { kind: "failed"; error: { code: string; message: string; details?: Record<string, unknown> } }
  | { kind: "retry" };

export type YouPetActionRequestMutationExecutor = (params: {
  routeId: YouPetActionRequestRouteId;
  envelope: YouPetActionRequestEnvelope;
  idempotencyKey: string;
}) => Promise<YouPetMutationOutcome>;

export type YouPetActionRequestDispatchResult = {
  listed: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
  conflicted: number;
  errored: number;
};

const ACTION_REQUEST_PAGE_LIMIT = 200;
const ACTION_REQUEST_MAX_PAGES_PER_SLICE_PER_DISPATCH = 200;
const ACTION_REQUEST_PAGE_NO_PROGRESS_LIMIT = 64;
const EXECUTION_AUTHORIZATION_EXPIRED_CODE = "execution_authorization_expired";
const EXECUTION_AUTHORIZATION_EXPIRED_MESSAGE = "policy expired before execution completed";

export class YouPetActionRequestDispatcher {
  private readonly client: Pick<
    YouPetActionRequestClient,
    "claimExecution" | "get" | "list" | "updateExecution"
  >;
  private readonly tenantId: string;
  private readonly actorId: string;
  private readonly workerId: string;
  private readonly executeMutation: YouPetActionRequestMutationExecutor;
  private readonly logger: YouPetActionRequestLogger | undefined;
  private readonly now: () => Date;
  private readonly cursorStore: YouPetActionRequestCursorStore | undefined;
  private readonly sliceCursors = new Map<string, string | undefined>();

  constructor(params: {
    client: Pick<YouPetActionRequestClient, "claimExecution" | "get" | "list" | "updateExecution">;
    tenantId: string;
    actorId: string;
    workerId?: string;
    executeMutation: YouPetActionRequestMutationExecutor;
    logger?: YouPetActionRequestLogger;
    cursorStore?: YouPetActionRequestCursorStore;
    now?: () => Date;
  }) {
    requireUuid(params.tenantId, "tenant_id");
    requireOpaqueId(params.actorId, "proposer.id", 128);
    this.client = params.client;
    this.tenantId = params.tenantId;
    this.actorId = params.actorId;
    this.workerId = params.workerId ?? randomUUID();
    this.executeMutation = params.executeMutation;
    this.logger = params.logger;
    this.cursorStore = params.cursorStore;
    this.now = params.now ?? (() => new Date());
  }

  async dispatchOnce(): Promise<YouPetActionRequestDispatchResult> {
    const result: YouPetActionRequestDispatchResult = {
      listed: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      skipped: 0,
      conflicted: 0,
      errored: 0,
    };
    const processedCandidateIds = new Set<string>();
    for (const executionState of ["running", "queued", "not_started"] as const) {
      for (const approvalState of ["approved", "not_required"] as const) {
        await this.dispatchCandidatePages(
          { approvalState, executionState },
          processedCandidateIds,
          result,
        );
      }
    }
    return result;
  }

  private async dispatchCandidatePages(
    params: {
      approvalState: "approved" | "not_required";
      executionState: YouPetActionRequestExecutionState;
    },
    processedCandidateIds: Set<string>,
    result: YouPetActionRequestDispatchResult,
  ): Promise<void> {
    const savedCursor = this.loadSliceCursor(params);
    const seenSliceCandidateIds = new Set<string>();
    const headPage = await this.client.list({
      tenantId: this.tenantId,
      approvalState: params.approvalState,
      executionState: params.executionState,
      limit: ACTION_REQUEST_PAGE_LIMIT,
    });
    result.listed += headPage.items.length;
    await this.dispatchCandidatePageItems(
      headPage.items,
      processedCandidateIds,
      seenSliceCandidateIds,
      result,
    );
    if (!headPage.nextCursor) {
      this.clearSliceCursor(params);
      return;
    }

    let cursor = savedCursor ?? headPage.nextCursor;
    const seenBacklogCursors = new Set<string>([cursor]);
    let noProgressPages = 0;
    this.saveSliceCursor(params, cursor);
    for (
      let pageCount = 1;
      pageCount < ACTION_REQUEST_MAX_PAGES_PER_SLICE_PER_DISPATCH;
      pageCount += 1
    ) {
      const response = await this.client.list({
        tenantId: this.tenantId,
        approvalState: params.approvalState,
        executionState: params.executionState,
        limit: ACTION_REQUEST_PAGE_LIMIT,
        cursor,
      });
      result.listed += response.items.length;
      const newSliceCandidateCount = await this.dispatchCandidatePageItems(
        response.items,
        processedCandidateIds,
        seenSliceCandidateIds,
        result,
      );
      if (!response.nextCursor) {
        this.clearSliceCursor(params);
        return;
      }
      if (seenBacklogCursors.has(response.nextCursor)) {
        throw new Error("ActionRequest dispatch received a repeated next_cursor from Core");
      }
      noProgressPages = newSliceCandidateCount === 0 ? noProgressPages + 1 : 0;
      if (noProgressPages > ACTION_REQUEST_PAGE_NO_PROGRESS_LIMIT) {
        throw new Error("ActionRequest dispatch exceeded the pagination no-progress guard");
      }
      cursor = response.nextCursor;
      seenBacklogCursors.add(cursor);
      this.saveSliceCursor(params, cursor);
    }
  }

  private loadSliceCursor(params: {
    approvalState: "approved" | "not_required";
    executionState: YouPetActionRequestExecutionState;
  }): string | undefined {
    const sliceKey = `${params.approvalState}:${params.executionState}`;
    return (
      this.cursorStore?.load({
        tenantId: this.tenantId,
        actorId: this.actorId,
        approvalState: params.approvalState,
        executionState: params.executionState,
      }) ?? this.sliceCursors.get(sliceKey)
    );
  }

  private saveSliceCursor(
    params: {
      approvalState: "approved" | "not_required";
      executionState: YouPetActionRequestExecutionState;
    },
    cursor: string,
  ): void {
    const sliceKey = `${params.approvalState}:${params.executionState}`;
    this.sliceCursors.set(sliceKey, cursor);
    this.cursorStore?.save({
      tenantId: this.tenantId,
      actorId: this.actorId,
      approvalState: params.approvalState,
      executionState: params.executionState,
      nextCursor: cursor,
    });
  }

  private clearSliceCursor(params: {
    approvalState: "approved" | "not_required";
    executionState: YouPetActionRequestExecutionState;
  }): void {
    const sliceKey = `${params.approvalState}:${params.executionState}`;
    this.sliceCursors.delete(sliceKey);
    this.cursorStore?.clear({
      tenantId: this.tenantId,
      actorId: this.actorId,
      approvalState: params.approvalState,
      executionState: params.executionState,
    });
  }

  private async dispatchCandidatePageItems(
    items: readonly YouPetActionRequestEnvelope[],
    processedCandidateIds: Set<string>,
    seenSliceCandidateIds: Set<string>,
    result: YouPetActionRequestDispatchResult,
  ): Promise<number> {
    let newSliceCandidateCount = 0;
    for (const item of items) {
      const candidateId = item.action_request.id;
      if (seenSliceCandidateIds.has(candidateId)) {
        continue;
      }
      seenSliceCandidateIds.add(candidateId);
      newSliceCandidateCount += 1;
      if (processedCandidateIds.has(candidateId)) {
        continue;
      }
      processedCandidateIds.add(candidateId);
      await this.dispatchListedCandidate(item, result);
    }
    return newSliceCandidateCount;
  }

  private async dispatchListedCandidate(
    candidate: YouPetActionRequestEnvelope,
    result: YouPetActionRequestDispatchResult,
  ): Promise<void> {
    try {
      await this.dispatchCandidate(candidate, result);
    } catch (error) {
      result.errored += 1;
      this.logger?.error?.(
        `[youpet] ActionRequest ${candidate.action_request.id} dispatch failed: ${summarizeDispatchError(error)}`,
      );
    }
  }

  private async dispatchCandidate(
    initial: YouPetActionRequestEnvelope,
    result: YouPetActionRequestDispatchResult,
  ): Promise<void> {
    if (await this.recoverExpiredRunningCandidate(initial, result, "local-observation")) {
      return;
    }
    const routeId = matchActionRequestRoute(initial, {
      tenantId: this.tenantId,
      actorId: this.actorId,
      now: this.now(),
    });
    if (!routeId) {
      this.logger?.warn?.(
        `[youpet] Skipping ActionRequest ${initial.action_request.id}: request does not match the closed YouPet route inventory`,
      );
      result.skipped += 1;
      return;
    }

    let current = initial;
    if (current.action_request.execution.state === "not_started") {
      let queued: YouPetActionRequestEnvelope | undefined;
      try {
        queued = await this.tryTransition(current, "queued");
      } catch (error) {
        if (await this.handleExecutionAuthorizationExpiredDuringDispatch(current, error, result)) {
          return;
        }
        throw error;
      }
      if (!queued) {
        result.conflicted += 1;
        return;
      }
      current = queued;
    }
    if (
      current.action_request.execution.state === "queued" ||
      current.action_request.execution.state === "running"
    ) {
      let claimed: YouPetActionRequestEnvelope | undefined;
      try {
        claimed = await this.tryClaim(current);
      } catch (error) {
        if (await this.handleExecutionAuthorizationExpiredDuringDispatch(current, error, result)) {
          return;
        }
        throw error;
      }
      if (!claimed) {
        result.conflicted += 1;
        return;
      }
      current = claimed;
      result.claimed += 1;
    }
    if (
      current.action_request.execution.state !== "running" ||
      !hasActiveExecutionClaim(current, this.workerId, this.now())
    ) {
      result.skipped += 1;
      return;
    }

    const outcome = await this.executeMutation({
      routeId,
      envelope: current,
      idempotencyKey: stableKey(
        "mutation",
        current.action_request.id,
        YOUPET_ACTION_REQUEST_ROUTES[routeId].mutationOperation,
      ),
    });
    if (outcome.kind === "retry") {
      result.retried += 1;
      return;
    }

    const terminal = await this.tryTransition(
      current,
      outcome.kind === "succeeded" ? "succeeded" : "failed",
      {
        ...(outcome.kind === "succeeded" ? { result: outcome.result } : { error: outcome.error }),
        workerId: this.workerId,
      },
    );
    if (!terminal) {
      result.conflicted += 1;
      return;
    }
    if (outcome.kind === "succeeded") {
      result.succeeded += 1;
    } else {
      result.failed += 1;
    }
  }

  private async recoverExpiredRunningCandidate(
    current: YouPetActionRequestEnvelope,
    result: YouPetActionRequestDispatchResult,
    authority: "local-observation" | "core-expired",
  ): Promise<boolean> {
    if (
      current.action_request.execution.state !== "running" ||
      !matchActionRequestRouteInventory(current, {
        tenantId: this.tenantId,
        actorId: this.actorId,
      })
    ) {
      return false;
    }
    const now = this.now();
    if (
      authority === "local-observation" &&
      !hasRecoverablePolicyAuthorizationExpiry(current.action_request, now)
    ) {
      return false;
    }
    if (authority === "core-expired") {
      return await this.recoverAuthoritativelyExpiredRunningCandidate(current, result);
    }

    const recoveryMode = resolveExpiredRunningRecoveryMode(current, this.workerId, now);
    if (recoveryMode.kind === "skip-active-owner") {
      this.logger?.warn?.(
        `[youpet] Leaving expired running ActionRequest ${current.action_request.id} with active foreign owner ${recoveryMode.ownerId}`,
      );
      result.skipped += 1;
      return true;
    }
    if (recoveryMode.kind === "unrecoverable") {
      result.conflicted += 1;
      return true;
    }

    const recovered = await this.tryExpiredAuthorizationRecovery(
      current,
      recoveryMode.kind === "live-owner" ? this.workerId : undefined,
    );
    if (!recovered) {
      result.conflicted += 1;
      return true;
    }
    result.failed += 1;
    return true;
  }

  private async handleExecutionAuthorizationExpiredDuringDispatch(
    current: YouPetActionRequestEnvelope,
    error: unknown,
    result: YouPetActionRequestDispatchResult,
  ): Promise<boolean> {
    if (!isExecutionAuthorizationExpired(error)) {
      return false;
    }
    const latest = await this.client.get(current.action_request.id);
    if (await this.recoverExpiredRunningCandidate(latest, result, "core-expired")) {
      return true;
    }
    result.conflicted += 1;
    return true;
  }

  private async recoverAuthoritativelyExpiredRunningCandidate(
    current: YouPetActionRequestEnvelope,
    result: YouPetActionRequestDispatchResult,
  ): Promise<boolean> {
    const claim = current.execution_claim;
    const ownerId =
      typeof claim?.owner_id === "string" && claim.owner_id.length > 0 ? claim.owner_id : null;
    const leaseExpiresAt =
      typeof claim?.lease_expires_at === "string" && claim.lease_expires_at.length > 0
        ? claim.lease_expires_at
        : null;
    if ((ownerId === null) !== (leaseExpiresAt === null)) {
      result.conflicted += 1;
      return true;
    }
    if (ownerId === this.workerId && leaseExpiresAt !== null) {
      try {
        await this.performExpiredAuthorizationRecovery(current, this.workerId);
        result.failed += 1;
        return true;
      } catch (error) {
        if (!isExpiredAuthorizationRecoveryWorkerlessFallback(error)) {
          if (isExpiredAuthorizationRecoveryConflict(error)) {
            await this.client.get(current.action_request.id);
            result.conflicted += 1;
            return true;
          }
          throw error;
        }
      }
    }
    const workerless = await this.tryExpiredAuthorizationRecovery(current);
    if (!workerless) {
      if (ownerId === this.workerId && leaseExpiresAt !== null) {
        const recovered = await this.tryExpiredAuthorizationRecovery(current, this.workerId);
        if (recovered) {
          result.failed += 1;
          return true;
        }
      }
      result.conflicted += 1;
      return true;
    }
    result.failed += 1;
    return true;
  }

  private async tryTransition(
    current: YouPetActionRequestEnvelope,
    state: "queued" | "succeeded" | "failed",
    terminal: {
      result?: Record<string, unknown>;
      error?: YouPetActionRequestExecutionUpdate["error"];
      workerId?: string;
    } = {},
  ): Promise<YouPetActionRequestEnvelope | undefined> {
    try {
      return await this.client.updateExecution({
        actionRequestId: current.action_request.id,
        update: {
          state,
          expected_row_version: current.row_version,
          ...(terminal.workerId ? { worker_id: terminal.workerId } : {}),
          ...(terminal.result ? { result: terminal.result } : {}),
          ...(terminal.error ? { error: terminal.error } : {}),
        },
        // Worker scope prevents Core idempotency replay from making two CAS
        // contenders both appear to own the same transition.
        idempotencyKey: stableKey("execution", this.workerId, current.action_request.id, state),
      });
    } catch (error) {
      if (isExecutionConflict(error)) {
        await this.client.get(current.action_request.id);
        return undefined;
      }
      throw error;
    }
  }

  private async tryClaim(
    current: YouPetActionRequestEnvelope,
  ): Promise<YouPetActionRequestEnvelope | undefined> {
    try {
      return await this.client.claimExecution({
        actionRequestId: current.action_request.id,
        claim: {
          worker_id: this.workerId,
          expected_row_version: current.row_version,
        },
        idempotencyKey: stableKey(
          "claim",
          this.workerId,
          current.action_request.id,
          String(current.row_version),
        ),
      });
    } catch (error) {
      if (isClaimConflict(error)) {
        await this.client.get(current.action_request.id);
        return undefined;
      }
      throw error;
    }
  }

  private async tryExpiredAuthorizationRecovery(
    current: YouPetActionRequestEnvelope,
    workerId?: string,
  ): Promise<YouPetActionRequestEnvelope | undefined> {
    try {
      return await this.performExpiredAuthorizationRecovery(current, workerId);
    } catch (error) {
      if (isExpiredAuthorizationRecoveryConflict(error)) {
        await this.client.get(current.action_request.id);
        return undefined;
      }
      throw error;
    }
  }

  private async performExpiredAuthorizationRecovery(
    current: YouPetActionRequestEnvelope,
    workerId?: string,
  ): Promise<YouPetActionRequestEnvelope> {
    return await this.client.updateExecution({
      actionRequestId: current.action_request.id,
      update: {
        state: "failed",
        expected_row_version: current.row_version,
        ...(workerId ? { worker_id: workerId } : {}),
        error: buildExpiredAuthorizationRecoveryError(),
      },
      idempotencyKey: stableKey(
        "execution-recovery",
        current.action_request.id,
        String(current.row_version),
        workerId ?? "workerless",
      ),
    });
  }
}

export function matchActionRequestRoute(
  envelope: YouPetActionRequestEnvelope,
  params: { tenantId: string; actorId: string; now: Date },
): YouPetActionRequestRouteId | undefined {
  const routeId = matchActionRequestRouteInventory(envelope, params);
  if (!routeId || !isAuthorized(envelope.action_request, params.now)) {
    return undefined;
  }
  return routeId;
}

function matchActionRequestRouteInventory(
  envelope: YouPetActionRequestEnvelope,
  params: { tenantId: string; actorId: string },
): YouPetActionRequestRouteId | undefined {
  const request = envelope.action_request;
  if (
    request.tenant_id !== params.tenantId ||
    request.proposer.type !== "agent" ||
    request.proposer.id !== params.actorId ||
    request.payload.mode !== "inline" ||
    request.links.domain_event_ids.length === 0
  ) {
    return undefined;
  }
  const fields = request.payload.fields ?? {};
  if (
    request.action_type === "task.escalate" &&
    request.target.type === "task_instance" &&
    request.risk === YOUPET_ACTION_REQUEST_ROUTES["task-escalate"].risk &&
    request.policy.outcome === YOUPET_ACTION_REQUEST_ROUTES["task-escalate"].policyOutcome &&
    request.policy.required_approver_class ===
      YOUPET_ACTION_REQUEST_ROUTES["task-escalate"].requiredApproverClass &&
    request.approval.state === "approved" &&
    fields.task_id === request.target.id &&
    typeof fields.severity === "string" &&
    typeof fields.summary === "string"
  ) {
    return "task-escalate";
  }
  if (
    request.action_type === "workflow.mutate" &&
    request.target.type === "health_plan" &&
    request.risk === YOUPET_ACTION_REQUEST_ROUTES["health-plan-flow-link"].risk &&
    request.policy.outcome ===
      YOUPET_ACTION_REQUEST_ROUTES["health-plan-flow-link"].policyOutcome &&
    request.policy.required_approver_class === undefined &&
    request.approval.state === "not_required" &&
    (fields.plan_id === request.target.id || fields.health_plan_id === request.target.id) &&
    typeof fields.openclaw_flow_id === "string"
  ) {
    return "health-plan-flow-link";
  }
  return undefined;
}

export function stableYouPetMutationKey(
  actionRequestId: string,
  routeId: YouPetActionRequestRouteId,
): string {
  return stableKey(
    "mutation",
    actionRequestId,
    YOUPET_ACTION_REQUEST_ROUTES[routeId].mutationOperation,
  );
}

function validateProposalPayload(
  request: YouPetActionRequestCreate,
  routeId: YouPetActionRequestRouteId,
): void {
  const fields = request.payload.fields;
  if (
    routeId === "task-escalate" &&
    (fields.task_id !== request.target.id ||
      typeof fields.severity !== "string" ||
      typeof fields.summary !== "string")
  ) {
    throw new Error("task escalation proposal payload does not match its target");
  }
  if (
    routeId === "health-plan-flow-link" &&
    (fields.health_plan_id !== request.target.id || typeof fields.openclaw_flow_id !== "string")
  ) {
    throw new Error("health-plan flow-link proposal payload does not match its target");
  }
}

function isAuthorized(request: YouPetActionRequest, now: Date): boolean {
  if (hasPolicyAuthorizationExpired(request, now)) {
    return false;
  }
  if (request.policy.outcome === "allow") {
    return request.approval.state === "not_required";
  }
  if (request.policy.outcome === "require_approval") {
    return request.approval.state === "approved";
  }
  return false;
}

function parseActionRequestEnvelope(value: unknown): YouPetActionRequestEnvelope {
  const envelope = requireRecord(value, "ActionRequest envelope");
  const request = requireRecord(envelope.action_request, "ActionRequest envelope.action_request");
  const proposer = requireRecord(request.proposer, "ActionRequest proposer");
  const target = requireRecord(request.target, "ActionRequest target");
  const payload = requireRecord(request.payload, "ActionRequest payload");
  const policy = requireRecord(request.policy, "ActionRequest policy");
  const approval = requireRecord(request.approval, "ActionRequest approval");
  const execution = requireRecord(request.execution, "ActionRequest execution");
  const links = requireRecord(request.links, "ActionRequest links");
  const fields =
    payload.fields === undefined ? undefined : requireRecord(payload.fields, "payload.fields");
  if (!Array.isArray(links.domain_event_ids)) {
    throw new Error("ActionRequest links.domain_event_ids must be an array");
  }
  const parsed: YouPetActionRequestEnvelope = {
    action_request: {
      id: requireString(request.id, "ActionRequest id"),
      tenant_id: requireString(request.tenant_id, "ActionRequest tenant_id"),
      proposer: {
        type: requireString(proposer.type, "ActionRequest proposer.type"),
        id: requireString(proposer.id, "ActionRequest proposer.id"),
      },
      target: {
        type: requireString(target.type, "ActionRequest target.type"),
        id: requireString(target.id, "ActionRequest target.id"),
      },
      action_type: requireString(request.action_type, "ActionRequest action_type"),
      risk: requireString(request.risk, "ActionRequest risk"),
      payload: {
        mode: requireString(payload.mode, "ActionRequest payload.mode"),
        ...(fields ? { fields } : {}),
      },
      policy: {
        outcome: requireString(policy.outcome, "ActionRequest policy.outcome"),
        ...(policy.required_approver_class === null || policy.required_approver_class === undefined
          ? {}
          : {
              required_approver_class: requireString(
                policy.required_approver_class,
                "ActionRequest policy.required_approver_class",
              ),
            }),
        ...(policy.expires_at === null || policy.expires_at === undefined
          ? {}
          : { expires_at: requireString(policy.expires_at, "ActionRequest policy.expires_at") }),
      },
      approval: { state: requireString(approval.state, "ActionRequest approval.state") },
      execution: { state: requireString(execution.state, "ActionRequest execution.state") },
      links: {
        domain_event_ids: links.domain_event_ids.map((item) =>
          requireString(item, "ActionRequest links.domain_event_ids[]"),
        ),
      },
      correlation_id: requireString(request.correlation_id, "ActionRequest correlation_id"),
      created_at: requireString(request.created_at, "ActionRequest created_at"),
      updated_at: requireString(request.updated_at, "ActionRequest updated_at"),
    },
    row_version: requireInteger(envelope.row_version, "ActionRequest row_version"),
    execution_claim:
      envelope.execution_claim === null ? null : parseExecutionClaim(envelope.execution_claim),
  };
  requireUuid(parsed.action_request.id, "ActionRequest id");
  requireUuid(parsed.action_request.tenant_id, "ActionRequest tenant_id");
  requireUuid(parsed.action_request.target.id, "ActionRequest target.id");
  return parsed;
}

function isExecutionConflict(error: unknown): boolean {
  return (
    error instanceof YouPetActionRequestCoreError &&
    (error.code === "concurrency_conflict" ||
      error.code === "execution_lease_conflict" ||
      error.code === "execution_lease_not_owner" ||
      error.code === "execution_lease_expired")
  );
}

function isClaimConflict(error: unknown): boolean {
  return (
    error instanceof YouPetActionRequestCoreError &&
    (error.code === "concurrency_conflict" || error.code === "execution_lease_conflict")
  );
}

function isExpiredAuthorizationRecoveryConflict(error: unknown): boolean {
  return (
    error instanceof YouPetActionRequestCoreError &&
    (error.code === "concurrency_conflict" ||
      error.code === "execution_claim_required" ||
      error.code === "execution_lease_conflict" ||
      error.code === "execution_lease_not_owner" ||
      error.code === "execution_lease_expired")
  );
}

function isExecutionAuthorizationExpired(error: unknown): boolean {
  return (
    error instanceof YouPetActionRequestCoreError &&
    error.code === EXECUTION_AUTHORIZATION_EXPIRED_CODE
  );
}

function isExpiredAuthorizationRecoveryWorkerlessFallback(error: unknown): boolean {
  return error instanceof YouPetActionRequestCoreError && error.code === "invalid_execution_body";
}

function hasPolicyAuthorizationExpired(request: YouPetActionRequest, now: Date): boolean {
  if (!request.policy.expires_at) {
    return false;
  }
  const expiresAt = new Date(request.policy.expires_at);
  return !Number.isFinite(expiresAt.valueOf()) || expiresAt <= now;
}

function hasRecoverablePolicyAuthorizationExpiry(request: YouPetActionRequest, now: Date): boolean {
  if (!request.policy.expires_at) {
    return false;
  }
  const expiresAt = new Date(request.policy.expires_at);
  return Number.isFinite(expiresAt.valueOf()) && expiresAt <= now;
}

function buildExpiredAuthorizationRecoveryError(): NonNullable<
  YouPetActionRequestExecutionUpdate["error"]
> {
  return {
    code: EXECUTION_AUTHORIZATION_EXPIRED_CODE,
    message: EXECUTION_AUTHORIZATION_EXPIRED_MESSAGE,
  };
}

function resolveExpiredRunningRecoveryMode(
  envelope: YouPetActionRequestEnvelope,
  workerId: string,
  now: Date,
):
  | { kind: "live-owner" }
  | { kind: "workerless" }
  | { kind: "skip-active-owner"; ownerId: string }
  | { kind: "unrecoverable" } {
  const claim = envelope.execution_claim;
  if (!claim) {
    return { kind: "workerless" };
  }
  const ownerId =
    typeof claim.owner_id === "string" && claim.owner_id.length > 0 ? claim.owner_id : null;
  const leaseExpiresAt =
    typeof claim.lease_expires_at === "string" && claim.lease_expires_at.length > 0
      ? claim.lease_expires_at
      : null;
  if (!ownerId && !leaseExpiresAt) {
    return { kind: "workerless" };
  }
  if (!ownerId || !leaseExpiresAt) {
    return { kind: "unrecoverable" };
  }
  const leaseExpiry = new Date(leaseExpiresAt);
  if (!Number.isFinite(leaseExpiry.valueOf())) {
    return { kind: "unrecoverable" };
  }
  if (leaseExpiry > now) {
    if (ownerId === workerId) {
      return { kind: "live-owner" };
    }
    return { kind: "skip-active-owner", ownerId };
  }
  return { kind: "workerless" };
}

function summarizeDispatchError(error: unknown): string {
  if (error instanceof YouPetActionRequestCoreError) {
    return `YouPet Core ActionRequest request failed ${error.status} ${error.path}`;
  }
  return "candidate execution aborted";
}

function readCoreErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const detail = (value as Record<string, unknown>).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return undefined;
  }
  const code = (detail as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function stableKey(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `openclaw.youpet.${parts[0]}.${digest}`;
}

function deterministicUuid(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireUuid(value: string, surface: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${surface} must be a UUID`);
  }
}

function requireOpaqueId(value: string, surface: string, maxLength: number): void {
  if (
    value.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ||
    /[sS][kK]-[A-Za-z0-9]{8,}/u.test(value)
  ) {
    throw new Error(`${surface} must be a secret-safe opaque identifier`);
  }
}

function requireUtcTimestamp(value: string, surface: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new Error(`${surface} must be a valid UTC timestamp`);
  }
  return parsed.toISOString();
}

function requireRecord(value: unknown, surface: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${surface} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, surface: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${surface} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, surface: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${surface} must be a positive integer`);
  }
  return value;
}

function parseExecutionClaim(value: unknown): YouPetActionRequestExecutionClaim {
  const claim = requireRecord(value, "ActionRequest execution_claim");
  return {
    owner_id: requireString(claim.owner_id, "ActionRequest execution_claim.owner_id"),
    lease_expires_at: requireString(
      claim.lease_expires_at,
      "ActionRequest execution_claim.lease_expires_at",
    ),
  };
}

function hasActiveExecutionClaim(
  envelope: YouPetActionRequestEnvelope,
  workerId: string,
  now: Date,
): boolean {
  const claim = envelope.execution_claim;
  if (!claim || claim.owner_id !== workerId) {
    return false;
  }
  const expiresAt = new Date(claim.lease_expires_at);
  return Number.isFinite(expiresAt.valueOf()) && expiresAt > now;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("YouPet Core returned invalid JSON");
  }
}
