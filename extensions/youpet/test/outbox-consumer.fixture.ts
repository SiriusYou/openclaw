import type { YouPetOutboxEventEnvelope } from "../src/outbox-consumer.js";

export function createCoreOutboxEvent(
  eventType: string,
  businessPayload: Record<string, unknown> = {},
  overrides: Partial<YouPetOutboxEventEnvelope> = {},
): YouPetOutboxEventEnvelope {
  const eventId = overrides.event_id ?? `evt-${eventType}`;
  const correlationId = overrides.correlation_id ?? "corr-1";
  const aggregateId =
    typeof businessPayload.task_id === "string" ? businessPayload.task_id : "task-1";
  return {
    event_id: eventId,
    consumer: "openclaw",
    state: "pending",
    attempts: 0,
    next_attempt_at: "2026-06-01T00:00:00Z",
    last_attempt_at: null,
    delivered_at: null,
    dead_lettered_at: null,
    last_error: null,
    event_type: eventType,
    aggregate_type: "task_instance",
    aggregate_id: aggregateId,
    correlation_id: correlationId,
    payload: {
      aggregate: {
        id: aggregateId,
        type: "task_instance",
      },
      correlation_id: correlationId,
      event_id: `payload-${eventId}`,
      event_type: eventType,
      event_version: 1,
      idempotency_key: `idem-${eventType}`,
      occurred_at: "2026-06-01T00:00:00Z",
      payload: businessPayload,
      producer: "youpet-core",
    },
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

export const TASK_MISSED_CORE_OUTBOX_EVENT = createCoreOutboxEvent("task.missed", {
  task_id: "task-1",
  plan_id: "plan-1",
  pet_id: "pet-1",
  owner_user_id: "owner-1",
  missed_count: 2,
  missed_threshold: 2,
  due_at: "2026-06-01T00:00:00Z",
});
