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
  fetchFn?: YouPetOutboxFetch;
  logger?: YouPetOutboxConsumerLogger;
  handlers?: Partial<Record<YouPetOpenClawEventType, YouPetOutboxEventHandler>>;
}

export interface ResolvedYouPetOutboxConsumerSettings
  extends Required<
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
    >
  > {
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
    const items = Array.isArray(response.items)
      ? response.items.map((item) => normalizeOutboxEvent(item))
      : [];

    const result: YouPetOutboxPollResult = {
      pulled: items.length,
      processed: 0,
      acknowledged: 0,
      nacked: 0,
    };

    for (const item of items) {
      result.processed += 1;
      try {
        await this.processEvent(item);
      } catch (error) {
        await this.nack(item.event_id, formatError(error));
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
      if (this.settings.ackUnhandledEvents) {
        return;
      }
      throw new Error(`Unhandled YouPet event type: ${event.event_type}`);
    }

    const handler = this.settings.handlers?.[event.event_type];
    if (handler) {
      await handler(event, { consumer: this });
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
      return;
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

    await this.requestJson<unknown>(`/api/v1/tasks/${encodeURIComponent(taskId)}/escalate`, {
      method: "POST",
      body: {
        severity: "medium",
        summary: "Task missed the configured YouPet check-in threshold.",
      },
      idempotencyKey: `openclaw:youpet:${event.event_id}:escalate`,
      correlationId: event.correlation_id ?? undefined,
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
    outboxLimit: readConfigInteger(config.outboxLimit, env.YOUPET_OPENCLAW_OUTBOX_LIMIT, 20, 1, 500),
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

function readConfigBoolean(value: unknown, envValue: string | undefined, fallback: boolean): boolean {
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
