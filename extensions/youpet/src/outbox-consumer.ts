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

export interface YouPetOutboxEventEnvelope {
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
  actorId?: string;
  outboxConsumer?: "openclaw";
  outboxLimit?: number;
  pollIntervalMs?: number;
  ackUnhandledEvents?: boolean;
  escalateMissedTasks?: boolean;
  manageFlows?: boolean;
  flowStore?: YouPetFlowStore;
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
  fetchFn?: YouPetOutboxFetch;
  logger?: YouPetOutboxConsumerLogger;
  handlers?: Partial<Record<YouPetOpenClawEventType, YouPetOutboxEventHandler>>;
}

type ResolvedRuntimeSettings = Omit<ResolvedYouPetOutboxConsumerSettings, "fetchFn"> & {
  fetchFn: YouPetOutboxFetch;
};

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
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight = false;

  constructor(settings: YouPetOutboxConsumerSettings) {
    const fetchFn = settings.fetchFn ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error("YouPet outbox consumer requires fetch");
    }
    this.settings = {
      enabled: settings.enabled ?? true,
      coreBaseUrl: normalizeBaseUrl(settings.coreBaseUrl),
      serviceToken: settings.serviceToken,
      actorId: settings.actorId ?? "openclaw-youpet-consumer",
      outboxConsumer: settings.outboxConsumer ?? "openclaw",
      outboxLimit: clampInteger(settings.outboxLimit, 20, 1, 500),
      pollIntervalMs: clampInteger(settings.pollIntervalMs, 5_000, 1_000, 60 * 60 * 1_000),
      ackUnhandledEvents: settings.ackUnhandledEvents ?? true,
      escalateMissedTasks: settings.escalateMissedTasks ?? true,
      manageFlows: settings.manageFlows ?? true,
      flowStore: settings.flowStore,
      fetchFn,
      logger: settings.logger,
      handlers: settings.handlers,
    };
  }

  startPolling(): void {
    if (this.timer) {
      return;
    }
    void this.pollSafely();
    this.timer = setInterval(() => {
      void this.pollSafely();
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
      const rawEventId = readRawEventId(rawItem);
      if (!rawEventId) {
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
          `[youpet] Nacking malformed outbox item ${rawEventId}: ${formattedError}`,
        );
        await this.nack(rawEventId, formattedError);
        result.nacked += 1;
        continue;
      }

      try {
        await this.processEvent(item);
      } catch (error) {
        const formattedError = formatError(error);
        this.settings.logger?.warn?.(
          `[youpet] Nacking malformed or failed ${item.event_type} event ${item.event_id}: ` +
            formattedError,
        );
        await this.nack(item.event_id, formattedError);
        result.nacked += 1;
        continue;
      }
      await this.ack(item.event_id);
      result.acknowledged += 1;
    }

    return result;
  }

  async processEvent(event: YouPetOutboxEventEnvelope): Promise<void> {
    if (!isYouPetOpenClawEventType(event.event_type)) {
      this.settings.logger?.info?.(
        `[youpet] Acknowledging unhandled outbox event type: ${event.event_type}`,
      );
      return;
    }

    const handler = this.settings.handlers?.[event.event_type];
    if (handler) {
      await handler(event, { consumer: this });
      return;
    }

    // Production flow behavior is built in here; settings.handlers remains only
    // an override seam, so config-only installs cannot ack-drop supported flows.
    if (event.event_type === "health_plan.activated") {
      await this.handleHealthPlanActivated(event);
      return;
    }

    if (event.event_type === "task.checkin_received") {
      await this.handleTaskCheckinReceived(event);
      return;
    }

    if (event.event_type === "task.missed") {
      await this.handleTaskMissed(event);
    }
  }

  async ack(eventId: string): Promise<YouPetOutboxDelivery> {
    return await this.requestJson<YouPetOutboxDelivery>(
      `/internal/events/outbox/${encodeURIComponent(eventId)}/ack`,
      {
        method: "POST",
        query: {
          consumer: this.settings.outboxConsumer,
        },
      },
    );
  }

  async nack(eventId: string, error: string): Promise<YouPetOutboxDelivery> {
    return await this.requestJson<YouPetOutboxDelivery>(
      `/internal/events/outbox/${encodeURIComponent(eventId)}/nack`,
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

  private async pollSafely(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      await this.pollOnce();
    } catch (error) {
      this.settings.logger?.error?.(`[youpet] Outbox poll failed: ${formatError(error)}`);
    } finally {
      this.pollInFlight = false;
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

    try {
      await this.requestJson<unknown>(`/api/v1/tasks/${encodeURIComponent(taskId)}/escalate`, {
        method: "POST",
        body: {
          severity: "medium",
          summary: "Task missed the configured YouPet check-in threshold.",
        },
        idempotencyKey: `openclaw:youpet:${event.event_id}:escalate`,
        correlationId: event.correlation_id ?? undefined,
      });
    } catch (error) {
      const conflict = readInvalidTaskStateConflict(error);
      if (!conflict) {
        throw error;
      }
      this.settings.logger?.warn?.(
        `[youpet] Acknowledging terminal task.missed escalation conflict ${JSON.stringify({
          event_id: event.event_id,
          task_id: taskId,
          current_status: conflict.currentStatus ?? null,
          allowed_statuses: conflict.allowedStatuses ?? [],
        })}`,
      );
    }
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
    // Flow creation is event-ledgered, but Core writeback is a separate
    // completion step. Gate on the link marker so a failed writeback can retry
    // on redelivery even when the activation event is already ledgered.
    if (flow.core_linked) {
      return;
    }

    try {
      await this.requestJson<unknown>(`/api/v1/health-plans/${encodeURIComponent(planId)}/flow`, {
        method: "POST",
        body: {
          openclaw_flow_id: flow.flow_id,
        },
        idempotencyKey: `openclaw:youpet:${event.event_id}:flow-link`,
        correlationId: event.correlation_id ?? undefined,
      });
      this.settings.flowStore.markFlowCoreLinked(planId);
    } catch (error) {
      const conflict = readFlowIdConflict(error);
      if (!conflict) {
        throw error;
      }
      this.settings.logger?.warn?.(
        `[youpet] Acknowledging terminal health_plan.activated flow-link conflict ${JSON.stringify({
          event_id: event.event_id,
          plan_id: planId,
          current_flow_id: conflict.currentFlowId ?? null,
          attempted_flow_id: conflict.attemptedFlowId ?? null,
        })}`,
      );
      this.settings.flowStore.markFlowCoreLinked(planId);
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
      correlationId?: string;
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
  settings: Pick<YouPetOutboxConsumerSettings, "coreBaseUrl" | "serviceToken">,
): boolean {
  return settings.coreBaseUrl.trim().length > 0 && settings.serviceToken.trim().length > 0;
}

function normalizeOutboxEvent(item: unknown): YouPetOutboxEventEnvelope {
  if (!item || typeof item !== "object") {
    throw new Error("YouPet outbox item must be an object");
  }
  const row = item as Record<string, unknown>;
  return {
    event_id: requireString(row.event_id, "event_id"),
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
    payload: readRecord(row.payload),
    created_at: requireString(row.created_at, "created_at"),
  };
}

function readRawEventId(item: unknown): string | undefined {
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

function readInvalidTaskStateConflict(
  error: unknown,
): { currentStatus: string | undefined; allowedStatuses: string[] | undefined } | undefined {
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
  if (!detail || detail.code !== "invalid_task_state") {
    return undefined;
  }
  return {
    currentStatus: typeof detail.current_status === "string" ? detail.current_status : undefined,
    allowedStatuses: Array.isArray(detail.allowed_statuses)
      ? detail.allowed_statuses.filter((value): value is string => typeof value === "string")
      : undefined,
  };
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
