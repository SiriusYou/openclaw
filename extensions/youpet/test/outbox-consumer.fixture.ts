import type {
  YouPetActionRequestCreate,
  YouPetActionRequestEnvelope,
} from "../src/action-request-routing.js";
import type { YouPetOutboxDeliveryEnvelope } from "../src/outbox-consumer.js";

export const TEST_TENANT_ID = "00000000-0000-4000-8000-000000000101";
export const TEST_TASK_ID = "00000000-0000-4000-8000-000000000201";
export const TEST_PLAN_ID = "00000000-0000-4000-8000-000000000301";
export const TEST_PET_ID = "00000000-0000-4000-8000-000000000501";

type CreateCoreOutboxEventOptions = {
  innerEventId?: string;
};

export function createCoreOutboxEvent(
  eventType: string,
  businessPayload: Record<string, unknown> = {},
  overrides: Partial<YouPetOutboxDeliveryEnvelope> = {},
  options: CreateCoreOutboxEventOptions = {},
): YouPetOutboxDeliveryEnvelope {
  const deliveryId = overrides.event_id ?? `evt-${eventType}`;
  const innerEventId = options.innerEventId ?? `payload-${deliveryId}`;
  const correlationId = overrides.correlation_id ?? "corr-1";
  const aggregateId =
    typeof businessPayload.task_id === "string"
      ? businessPayload.task_id
      : "00000000-0000-4000-8000-000000000201";
  return {
    event_id: deliveryId,
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
      event_id: innerEventId,
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
  task_id: TEST_TASK_ID,
  plan_id: TEST_PLAN_ID,
  pet_id: TEST_PET_ID,
  owner_user_id: "00000000-0000-4000-8000-000000000701",
  missed_count: 2,
  missed_threshold: 2,
  due_at: "2026-06-01T00:00:00Z",
});

export function actionRequestEnvelopeFromCreate(
  request: YouPetActionRequestCreate,
  rowVersion = 1,
): YouPetActionRequestEnvelope {
  const approvalState = request.policy.outcome === "allow" ? "not_required" : "pending";
  return {
    action_request: {
      id: request.id,
      tenant_id: request.tenant_id,
      proposer: request.proposer,
      target: request.target,
      action_type: request.action_type,
      risk: request.risk,
      payload: request.payload,
      policy: {
        outcome: request.policy.outcome,
        ...(request.policy.required_approver_class
          ? { required_approver_class: request.policy.required_approver_class }
          : {}),
      },
      approval: { state: approvalState },
      execution: { state: "not_started" },
      links: { domain_event_ids: request.links.domain_event_ids },
      correlation_id: request.correlation_id ?? "corr-server-generated",
      created_at: request.policy.decided_at,
      updated_at: request.policy.decided_at,
    },
    row_version: rowVersion,
    execution_claim: null,
  };
}
