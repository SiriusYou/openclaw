import type { YouPetActionRequestCursorStore } from "./action-request-cursor-store.js";
import {
  buildYouPetActionRequestProposal,
  YouPetActionRequestClient,
  YouPetActionRequestCoreError,
  YouPetActionRequestDispatcher,
  type YouPetActionRequestDispatchResult,
  type YouPetActionRequestEnvelope,
  type YouPetActionRequestRouteId,
  type YouPetMutationOutcome,
} from "./action-request-routing.js";
import type { YouPetFlowStore } from "./flow-store.js";

export const SUPPORTED_YOUPET_OPENCLAW_EVENT_TYPES = [
  "wecom.message.received",
  "health_plan.activated",
  "task.checkin_received",
  "task.missed",
  "alert.acknowledged",
  "alert.resolved",
] as const;

export type YouPetOpenClawEventType = (typeof SUPPORTED_YOUPET_OPENCLAW_EVENT_TYPES)[number];

export type YouPetOutboxDeliveryState = "pending" | "delivered" | "dead_lettered";

export type YouPetOutboxFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface YouPetOutboxDeliveryEnvelope {
  event_id: string;
  consumer: "openclaw";
  state: YouPetOutboxDeliveryState;
  attempts: number;
  next_attempt_at: string;
  last_attempt_at?: string | null;
  delivered_at?: string | null;
  dead_lettered_at?: string | null;
  last_error?: string | null;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface YouPetOutboxEventEnvelope {
  delivery_id: string;
  event_id: string;
  consumer: "openclaw";
  state: YouPetOutboxDeliveryState;
  attempts: number;
  next_attempt_at: string;
  last_attempt_at?: string | null;
  delivered_at?: string | null;
  dead_lettered_at?: string | null;
  last_error?: string | null;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface YouPetOutboxDelivery {
  event_id: string;
  consumer: "openclaw";
  state: YouPetOutboxDeliveryState;
  attempts: number;
  next_attempt_at: string;
  last_attempt_at?: string | null;
  delivered_at?: string | null;
  dead_lettered_at?: string | null;
  last_error?: string | null;
}

export interface YouPetOutboxPollResult {
  pulled: number;
  processed: number;
  acknowledged: number;
  nacked: number;
  skipped: number;
}

export interface YouPetOutboxConsumerLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface YouPetOutboxEventHandlerContext {
  consumer: YouPetOutboxConsumer;
}

export type YouPetOutboxEventHandler = (
  event: YouPetOutboxEventEnvelope,
  context: YouPetOutboxEventHandlerContext,
) => void | Promise<void>;

export interface YouPetOutboxConsumerSettings {
  enabled?: boolean;
  coreBaseUrl: string;
  serviceToken: string;
  tenantId?: string;
  actorId?: string;
  workerId?: string;
  outboxConsumer?: "openclaw";
  outboxLimit?: number;
  pollIntervalMs?: number;
  ackUnhandledEvents?: boolean;
  escalateMissedTasks?: boolean;
  manageFlows?: boolean;
  flowStore?: YouPetFlowStore;
  actionRequestCursorStore?: YouPetActionRequestCursorStore;
  fetchFn?: YouPetOutboxFetch;
  logger?: YouPetOutboxConsumerLogger;
  handlers?: Partial<Record<YouPetOpenClawEventType, YouPetOutboxEventHandler>>;
}

export interface ResolvedYouPetOutboxConsumerSettings extends Required<
  Pick<
    YouPetOutboxConsumerSettings,
    | "enabled"
    | "coreBaseUrl"
    | "serviceToken"
    | "tenantId"
    | "actorId"
    | "outboxConsumer"
    | "outboxLimit"
    | "pollIntervalMs"
    | "ackUnhandledEvents"
    | "escalateMissedTasks"
    | "manageFlows"
  >
> {
  flowStore?: YouPetFlowStore;
  actionRequestCursorStore?: YouPetActionRequestCursorStore;
  fetchFn?: YouPetOutboxFetch;
  logger?: YouPetOutboxConsumerLogger;
  handlers?: Partial<Record<YouPetOpenClawEventType, YouPetOutboxEventHandler>>;
}

type ResolvedRuntimeSettings = Omit<ResolvedYouPetOutboxConsumerSettings, "fetchFn"> & {
  fetchFn: YouPetOutboxFetch;
};

type YouPetOutboxProcessEventResult = "handled" | "unhandled";

export class YouPetCoreRequestError extends Error {
  readonly status: number;
  readonly path: string;
  readonly responseBody: string;

  constructor(params: { status: number; path: string; responseBody: string }) {
    super(`YouPet Core request failed ${params.status} ${params.path}: ${params.responseBody}`);
    this.name = "YouPetCoreRequestError";
    this.status = params.status;
    this.path = params.path;
    this.responseBody = params.responseBody;
  }
}

export class YouPetOutboxConsumer {
  private readonly settings: ResolvedRuntimeSettings;
  private readonly actionRequests: YouPetActionRequestClient;
  private readonly actionRequestDispatcher: YouPetActionRequestDispatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cycleInFlight = false;

  constructor(settings: YouPetOutboxConsumerSettings) {
    const fetchFn = settings.fetchFn ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error("YouPet outbox consumer requires fetch");
    }
    this.settings = {
      enabled: settings.enabled ?? true,
      coreBaseUrl: normalizeBaseUrl(settings.coreBaseUrl),
      serviceToken: settings.serviceToken,
      tenantId: settings.tenantId ?? "",
      actorId: settings.actorId ?? "openclaw-youpet-consumer",
      outboxConsumer: settings.outboxConsumer ?? "openclaw",
      outboxLimit: clampInteger(settings.outboxLimit, 20, 1, 500),
      pollIntervalMs: clampInteger(settings.pollIntervalMs, 5_000, 1_000, 60 * 60 * 1_000),
      ackUnhandledEvents: settings.ackUnhandledEvents ?? true,
      escalateMissedTasks: settings.escalateMissedTasks ?? true,
      manageFlows: settings.manageFlows ?? true,
      flowStore: settings.flowStore,
      actionRequestCursorStore: settings.actionRequestCursorStore,
      fetchFn,
      logger: settings.logger,
      handlers: settings.handlers,
    };
    this.actionRequests = new YouPetActionRequestClient({
      coreBaseUrl: this.settings.coreBaseUrl,
      serviceToken: this.settings.serviceToken,
      actorId: this.settings.actorId,
      fetchFn,
    });
    this.actionRequestDispatcher = isUuid(this.settings.tenantId)
      ? new YouPetActionRequestDispatcher({
          client: this.actionRequests,
          tenantId: this.settings.tenantId,
          actorId: this.settings.actorId,
          workerId: settings.workerId,
          executeMutation: async (params) => await this.executeActionRequestMutation(params),
          logger: this.settings.logger,
          cursorStore: this.settings.actionRequestCursorStore,
        })
      : undefined;
  }

  startPolling(): void {
    if (this.timer) {
      return;
    }
    void this.runCycleSafely();
    this.timer = setInterval(() => {
      void this.runCycleSafely();
    }, this.settings.pollIntervalMs);
  }

  stopPolling(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollOnce(): Promise<YouPetOutboxPollResult> {
    const response = await this.requestJson<{ items?: unknown }>("/internal/events/outbox", {
      method: "GET",
      query: {
        consumer: this.settings.outboxConsumer,
        limit: String(this.settings.outboxLimit),
      },
    });
    const items = Array.isArray(response.items) ? response.items : [];

    const result: YouPetOutboxPollResult = {
      pulled: items.length,
      processed: 0,
      acknowledged: 0,
      nacked: 0,
      skipped: 0,
    };

    for (const rawItem of items) {
      result.processed += 1;
      const rawDeliveryId = readRawDeliveryId(rawItem);
      if (!rawDeliveryId) {
        this.settings.logger?.error?.("[youpet] Skipping outbox item with missing event_id");
        result.skipped += 1;
        continue;
      }

      let item: YouPetOutboxEventEnvelope;
      try {
        item = normalizeOutboxEvent(rawItem);
      } catch (error) {
        const formattedError = formatError(error);
        this.settings.logger?.warn?.(
          `[youpet] Nacking malformed outbox item ${rawDeliveryId}: ${formattedError}`,
        );
        await this.nack(rawDeliveryId, formattedError);
        result.nacked += 1;
        continue;
      }

      let outcome: YouPetOutboxProcessEventResult;
      try {
        outcome = await this.processEvent(item);
      } catch (error) {
        const formattedError = safeErrorSummary(error);
        this.settings.logger?.warn?.(
          `[youpet] Nacking malformed or failed ${item.event_type} delivery ${item.delivery_id} ` +
            `(domain event ${item.event_id}): ${formattedError}`,
        );
        await this.nack(item.delivery_id, formattedError);
        result.nacked += 1;
        continue;
      }
      if (outcome === "unhandled") {
        if (!this.settings.ackUnhandledEvents) {
          this.settings.logger?.info?.(
            `[youpet] Nacking unsupported ${item.event_type} delivery ${item.delivery_id} ` +
              `(domain event ${item.event_id})`,
          );
          await this.nack(item.delivery_id, `unsupported_event_type: ${item.event_type}`);
          result.nacked += 1;
          continue;
        }
        this.settings.logger?.info?.(
          `[youpet] Acknowledging unhandled outbox event type: ${item.event_type}`,
        );
      }
      await this.ack(item.delivery_id);
      result.acknowledged += 1;
    }

    return result;
  }

  async dispatchActionRequestsOnce(): Promise<YouPetActionRequestDispatchResult> {
    if (!this.actionRequestDispatcher) {
      throw new Error("YouPet ActionRequest routing requires an explicit UUID tenantId");
    }
    return await this.actionRequestDispatcher.dispatchOnce();
  }

  async processEvent(event: YouPetOutboxEventEnvelope): Promise<YouPetOutboxProcessEventResult> {
    if (!isYouPetOpenClawEventType(event.event_type)) {
      return "unhandled";
    }

    const handler = this.settings.handlers?.[event.event_type];
    if (handler) {
      await handler(event, { consumer: this });
      return "handled";
    }

    // Production flow behavior is built in here; settings.handlers remains only
    // an override seam, so config-only installs cannot ack-drop supported flows.
    if (event.event_type === "health_plan.activated") {
      await this.handleHealthPlanActivated(event);
      return "handled";
    }

    if (event.event_type === "task.checkin_received") {
      await this.handleTaskCheckinReceived(event);
      return "handled";
    }

    if (event.event_type === "task.missed") {
      await this.handleTaskMissed(event);
      return "handled";
    }

    return "handled";
  }

  async ack(deliveryId: string): Promise<YouPetOutboxDelivery> {
    return await this.requestJson<YouPetOutboxDelivery>(
      `/internal/events/outbox/${encodeURIComponent(deliveryId)}/ack`,
      {
        method: "POST",
        query: {
          consumer: this.settings.outboxConsumer,
        },
      },
    );
  }

  async nack(deliveryId: string, error: string): Promise<YouPetOutboxDelivery> {
    return await this.requestJson<YouPetOutboxDelivery>(
      `/internal/events/outbox/${encodeURIComponent(deliveryId)}/nack`,
      {
        method: "POST",
        query: {
          consumer: this.settings.outboxConsumer,
        },
        body: {
          error: error.slice(0, 1_000),
        },
      },
    );
  }

  private async runCycleSafely(): Promise<void> {
    if (this.cycleInFlight) {
      return;
    }
    this.cycleInFlight = true;
    try {
      try {
        await this.pollOnce();
      } catch (error) {
        this.settings.logger?.error?.(`[youpet] Outbox poll failed: ${safeErrorSummary(error)}`);
      }
      try {
        await this.dispatchActionRequestsOnce();
      } catch (error) {
        this.settings.logger?.error?.(
          `[youpet] ActionRequest dispatch failed: ${safeErrorSummary(error)}`,
        );
      }
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async handleTaskMissed(event: YouPetOutboxEventEnvelope): Promise<void> {
    if (!this.settings.escalateMissedTasks) {
      return;
    }
    const payload = readCoreBusinessPayload(event);
    if (!payload) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed task.missed event ${event.event_id}: missing payload.payload`,
      );
      throw new Error("Malformed YouPet task.missed payload");
    }
    const taskId = readString(payload.task_id);
    const missedCount = readPositiveInteger(payload.missed_count);
    const missedThreshold = readPositiveInteger(payload.missed_threshold);
    if (!taskId || missedCount === undefined || missedThreshold === undefined) {
      return;
    }
    if (missedCount < missedThreshold) {
      return;
    }

    const proposal = buildYouPetActionRequestProposal({
      routeId: "task-escalate",
      tenantId: this.requireTenantId(),
      actorId: this.settings.actorId,
      sourceEventId: event.event_id,
      sourceOccurredAt: readSourceOccurredAt(event),
      correlationId: event.correlation_id,
      targetId: taskId,
      payloadFields: {
        task_id: taskId,
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
    });
    await this.actionRequests.create(proposal);
  }

  private async handleHealthPlanActivated(event: YouPetOutboxEventEnvelope): Promise<void> {
    if (!this.settings.manageFlows) {
      return;
    }
    const payload = readCoreBusinessPayload(event);
    if (!payload) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed health_plan.activated event ${event.event_id}: missing payload.payload`,
      );
      throw new Error("Malformed YouPet health_plan.activated payload");
    }
    const planId = readString(payload.plan_id)?.trim();
    if (!planId) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed health_plan.activated event ${event.event_id}: missing plan_id`,
      );
      throw new Error("Malformed YouPet health_plan.activated payload");
    }
    if (!isUuid(planId)) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed health_plan.activated event ${event.event_id}: plan_id must be a UUID`,
      );
      throw new Error("Malformed YouPet health_plan.activated payload");
    }
    if (!this.settings.flowStore) {
      throw new Error("YouPet health_plan.activated handling requires a flow store");
    }

    const petId = readString(payload.pet_id)?.trim();
    const flow = this.settings.flowStore.recordHealthPlanActivated({
      eventId: event.event_id,
      eventType: event.event_type,
      aggregateId: event.aggregate_id || null,
      planId,
      ...(petId ? { petId } : {}),
      correlationId: event.correlation_id ?? null,
    });
    // Flow identity is event-ledgered before proposal so redelivery produces
    // the same payload. Core remains the durable execution authority.
    if (flow.core_linked) {
      return;
    }
    const proposal = buildYouPetActionRequestProposal({
      routeId: "health-plan-flow-link",
      tenantId: this.requireTenantId(),
      actorId: this.settings.actorId,
      sourceEventId: event.event_id,
      sourceOccurredAt: readSourceOccurredAt(event),
      correlationId: event.correlation_id,
      targetId: planId,
      payloadFields: {
        health_plan_id: planId,
        openclaw_flow_id: flow.flow_id,
      },
    });
    await this.actionRequests.create(proposal);
  }

  private requireTenantId(): string {
    if (!isUuid(this.settings.tenantId)) {
      throw new Error("YouPet ActionRequest routing requires an explicit UUID tenantId");
    }
    return this.settings.tenantId;
  }

  private async executeActionRequestMutation(params: {
    routeId: YouPetActionRequestRouteId;
    envelope: YouPetActionRequestEnvelope;
    idempotencyKey: string;
  }): Promise<YouPetMutationOutcome> {
    const fields = params.envelope.action_request.payload.fields ?? {};
    const targetId = params.envelope.action_request.target.id;
    try {
      if (params.routeId === "task-escalate") {
        const response = await this.requestJson<Record<string, unknown>>(
          `/api/v1/tasks/${encodeURIComponent(targetId)}/escalate`,
          {
            method: "POST",
            body: {
              severity: requirePayloadString(fields.severity, "payload.fields.severity"),
              summary: requirePayloadString(fields.summary, "payload.fields.summary"),
            },
            idempotencyKey: params.idempotencyKey,
            correlationId: params.envelope.action_request.correlation_id,
          },
        );
        return {
          kind: "succeeded",
          result: {
            status_code: 201,
            outcome_code: "task_escalated",
            related_type: "alert",
            ...(readString(response.id) ? { related_id: readString(response.id) } : {}),
            retryable: false,
          },
        };
      }

      const flowId = requirePayloadString(
        fields.openclaw_flow_id,
        "payload.fields.openclaw_flow_id",
      );
      await this.requestJson<Record<string, unknown>>(
        `/api/v1/health-plans/${encodeURIComponent(targetId)}/flow`,
        {
          method: "POST",
          body: { openclaw_flow_id: flowId },
          idempotencyKey: params.idempotencyKey,
          correlationId: params.envelope.action_request.correlation_id,
        },
      );
      this.settings.flowStore?.markFlowCoreLinked(targetId);
      return {
        kind: "succeeded",
        result: {
          status_code: 200,
          outcome_code: "health_plan_flow_linked",
          related_type: "health_plan",
          related_id: targetId,
          retryable: false,
        },
      };
    } catch (error) {
      if (params.routeId !== "task-escalate") {
        const conflict = readFlowIdConflict(error);
        const attemptedFlowId = readString(fields.openclaw_flow_id);
        if (
          attemptedFlowId &&
          conflict?.currentFlowId === attemptedFlowId &&
          conflict.attemptedFlowId === attemptedFlowId
        ) {
          this.settings.flowStore?.markFlowCoreLinked(targetId);
          return {
            kind: "succeeded",
            result: {
              status_code: 409,
              outcome_code: "health_plan_flow_already_linked",
              related_type: "health_plan",
              related_id: targetId,
              retryable: false,
            },
          };
        }
      }
      if (!(error instanceof YouPetCoreRequestError) || isRetryableCoreStatus(error.status)) {
        return { kind: "retry" };
      }
      return {
        kind: "failed",
        error: {
          code: "youpet_core_mutation_rejected",
          message: "YouPet Core rejected the authorized mutation",
          details: {
            status_code: error.status,
            retryable: false,
            provider: "youpet_core",
            operation: params.routeId,
            related_type: params.envelope.action_request.target.type,
            related_id: targetId,
            reason_code: readCoreErrorCode(error) ?? "core_request_failed",
          },
        },
      };
    }
  }

  private async handleTaskCheckinReceived(event: YouPetOutboxEventEnvelope): Promise<void> {
    if (!this.settings.manageFlows) {
      return;
    }
    const payload = readCoreBusinessPayload(event);
    if (!payload) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed task.checkin_received event ${event.event_id}: missing payload.payload`,
      );
      throw new Error("Malformed YouPet task.checkin_received payload");
    }
    const planId = readString(payload.plan_id)?.trim();
    if (!planId) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed task.checkin_received event ${event.event_id}: missing plan_id`,
      );
      throw new Error("Malformed YouPet task.checkin_received payload");
    }
    const checkinId = readString(payload.checkin_id)?.trim();
    if (!checkinId) {
      this.settings.logger?.warn?.(
        `[youpet] Malformed task.checkin_received event ${event.event_id}: missing checkin_id`,
      );
      throw new Error("Malformed YouPet task.checkin_received payload");
    }
    if (!this.settings.flowStore) {
      throw new Error("YouPet task.checkin_received handling requires a flow store");
    }

    const petId = readString(payload.pet_id)?.trim();
    this.settings.flowStore.recordTaskCheckin({
      eventId: event.event_id,
      eventType: event.event_type,
      aggregateId: event.aggregate_id || null,
      planId,
      checkinId,
      ...(petId ? { petId } : {}),
      correlationId: event.correlation_id ?? null,
    });
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      query?: Record<string, string>;
      body?: unknown;
      idempotencyKey?: string;
      correlationId?: string | null;
    },
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.settings.serviceToken}`,
      "X-Actor-Id": this.settings.actorId,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    if (options.correlationId) {
      headers["X-Correlation-Id"] = options.correlationId;
    }

    const response = await this.settings.fetchFn(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new YouPetCoreRequestError({
        status: response.status,
        path,
        responseBody: await response.text(),
      });
    }
    return (await response.json()) as T;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(path, `${this.settings.coreBaseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

export function isYouPetOpenClawEventType(value: string): value is YouPetOpenClawEventType {
  return (SUPPORTED_YOUPET_OPENCLAW_EVENT_TYPES as readonly string[]).includes(value);
}

export function createYouPetOutboxConsumerSettingsFromConfig(params: {
  pluginConfig?: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): ResolvedYouPetOutboxConsumerSettings {
  const config = params.pluginConfig ?? {};
  const env = params.env;
  return {
    enabled: readConfigBoolean(config.enabled, env.YOUPET_OPENCLAW_ENABLED, false),
    coreBaseUrl: normalizeBaseUrl(
      readConfigString(config.coreBaseUrl, env.YOUPET_CORE_BASE_URL, ""),
    ),
    serviceToken: readConfigString(config.serviceToken, env.YOUPET_SERVICE_TOKEN, ""),
    tenantId: readConfigString(config.tenantId, env.YOUPET_TENANT_ID, ""),
    actorId: readConfigString(
      config.actorId,
      env.YOUPET_OPENCLAW_ACTOR_ID,
      "openclaw-youpet-consumer",
    ),
    outboxConsumer: "openclaw",
    outboxLimit: readConfigInteger(
      config.outboxLimit,
      env.YOUPET_OPENCLAW_OUTBOX_LIMIT,
      20,
      1,
      500,
    ),
    pollIntervalMs: readConfigInteger(
      config.pollIntervalMs,
      env.YOUPET_OPENCLAW_POLL_INTERVAL_MS,
      5_000,
      1_000,
      60 * 60 * 1_000,
    ),
    ackUnhandledEvents: readConfigBoolean(
      config.ackUnhandledEvents,
      env.YOUPET_OPENCLAW_ACK_UNHANDLED_EVENTS,
      true,
    ),
    escalateMissedTasks: readConfigBoolean(
      config.escalateMissedTasks,
      env.YOUPET_OPENCLAW_ESCALATE_MISSED_TASKS,
      true,
    ),
    manageFlows: readConfigBoolean(config.manageFlows, env.YOUPET_OPENCLAW_MANAGE_FLOWS, true),
  };
}

export function isYouPetOutboxConsumerConfigured(
  settings: Pick<YouPetOutboxConsumerSettings, "coreBaseUrl" | "serviceToken" | "tenantId">,
): boolean {
  return (
    settings.coreBaseUrl.trim().length > 0 &&
    settings.serviceToken.trim().length > 0 &&
    isUuid(settings.tenantId ?? "")
  );
}

function normalizeOutboxEvent(item: unknown): YouPetOutboxEventEnvelope {
  if (!item || typeof item !== "object") {
    throw new Error("YouPet outbox item must be an object");
  }
  const row = item as Record<string, unknown>;
  const payload = readRecord(row.payload);
  return {
    delivery_id: requireString(row.event_id, "event_id"),
    event_id: requireEnvelopeEventId(payload),
    consumer: "openclaw",
    state: requireDeliveryState(row.state),
    attempts: readPositiveInteger(row.attempts) ?? 0,
    next_attempt_at: requireString(row.next_attempt_at, "next_attempt_at"),
    last_attempt_at: readNullableString(row.last_attempt_at),
    delivered_at: readNullableString(row.delivered_at),
    dead_lettered_at: readNullableString(row.dead_lettered_at),
    last_error: readNullableString(row.last_error),
    event_type: requireString(row.event_type, "event_type"),
    aggregate_type: requireString(row.aggregate_type, "aggregate_type"),
    aggregate_id: requireString(row.aggregate_id, "aggregate_id"),
    correlation_id: readNullableString(row.correlation_id),
    payload,
    created_at: requireString(row.created_at, "created_at"),
  };
}

function readRawDeliveryId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  return readString((item as Record<string, unknown>).event_id);
}

function requireDeliveryState(value: unknown): YouPetOutboxDeliveryState {
  if (value === "pending" || value === "delivered" || value === "dead_lettered") {
    return value;
  }
  throw new Error("YouPet outbox item has invalid state");
}

function requireString(value: unknown, field: string): string {
  const text = readString(value);
  if (!text) {
    throw new Error(`YouPet outbox item missing ${field}`);
  }
  return text;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return readOptionalRecord(value) ?? {};
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCoreBusinessPayload(
  event: YouPetOutboxEventEnvelope,
): Record<string, unknown> | undefined {
  // Core stores an event envelope in the outbox row; business fields live under
  // payload.payload. Reading the row-level payload silently skips escalation.
  return readOptionalRecord(event.payload.payload);
}

function readSourceOccurredAt(event: YouPetOutboxEventEnvelope): string {
  return readString(event.payload.occurred_at) ?? event.created_at;
}

function requireEnvelopeEventId(payload: Record<string, unknown>): string {
  const eventId = readString(payload.event_id);
  if (!eventId) {
    throw new Error("YouPet outbox item missing payload.event_id");
  }
  return eventId;
}

function readFlowIdConflict(
  error: unknown,
): { currentFlowId: string | undefined; attemptedFlowId: string | undefined } | undefined {
  if (!(error instanceof YouPetCoreRequestError) || error.status !== 409) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(error.responseBody);
  } catch {
    return undefined;
  }
  const detail = readOptionalRecord(readOptionalRecord(body)?.detail);
  if (!detail || detail.code !== "flow_id_conflict") {
    return undefined;
  }
  return {
    currentFlowId: readString(detail.current_flow_id),
    attemptedFlowId: readString(detail.attempted_flow_id),
  };
}

function readCoreErrorCode(error: YouPetCoreRequestError): string | undefined {
  try {
    const body = readOptionalRecord(JSON.parse(error.responseBody));
    return readString(readOptionalRecord(body?.detail)?.code);
  } catch {
    return undefined;
  }
}

function isRetryableCoreStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function requirePayloadString(value: unknown, surface: string): string {
  const text = readString(value);
  if (!text) {
    throw new Error(`${surface} must be a non-empty string`);
  }
  return text;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return undefined;
  }
  return Math.trunc(numberValue);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function safeErrorSummary(error: unknown): string {
  if (error instanceof YouPetCoreRequestError) {
    return `YouPet Core request failed ${error.status} ${error.path}`;
  }
  if (error instanceof YouPetActionRequestCoreError) {
    return `YouPet Core ActionRequest request failed ${error.status} ${error.path}`;
  }
  return formatError(error);
}

function readConfigString(value: unknown, envValue: string | undefined, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  return fallback;
}

function readConfigBoolean(
  value: unknown,
  envValue: string | undefined,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (!envValue) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(envValue.trim().toLowerCase());
}

function readConfigInteger(
  value: unknown,
  envValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value === "number") {
    return clampInteger(value, fallback, min, max);
  }
  if (envValue) {
    return clampInteger(Number(envValue), fallback, min, max);
  }
  return fallback;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
