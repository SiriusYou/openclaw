import { randomUUID } from "node:crypto";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const YOUPET_FLOW_STORE_NAMESPACE = "flows";
export const YOUPET_PROCESSED_EVENT_STORE_NAMESPACE = "processed-events";

export const YOUPET_FLOW_STORE_MAX_ENTRIES = 10_000;
export const YOUPET_PROCESSED_EVENT_STORE_MAX_ENTRIES = 100_000;

export type YouPetFlowRecord = {
  flow_id: string;
  plan_id: string;
  pet_id?: string;
  status: "active";
  correlation_id: string | null;
  created_from_event_id: string;
  checkin_count: number;
  last_checkin_at: string | null;
  created_at: string;
  updated_at: string;
};

export type YouPetProcessedEventRecord = {
  event_id: string;
  flow_id: string;
  event_type: string;
  aggregate_id: string | null;
  processed_at: string;
};

export type YouPetFlowStoreStores = {
  flows: PluginStateSyncKeyedStore<YouPetFlowRecord>;
  processedEvents: PluginStateSyncKeyedStore<YouPetProcessedEventRecord>;
};

export type YouPetFlowStore = {
  recordHealthPlanActivated: (params: {
    eventId: string;
    eventType: string;
    aggregateId: string | null;
    planId: string;
    petId?: string;
    correlationId: string | null;
  }) => YouPetFlowRecord;
  lookupFlowByPlanId: (planId: string) => YouPetFlowRecord | undefined;
  lookupProcessedEvent: (eventId: string) => YouPetProcessedEventRecord | undefined;
};

export type YouPetFlowStoreRuntimeState = {
  openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<T>;
};

export function openYouPetFlowStore(runtimeState: YouPetFlowStoreRuntimeState): YouPetFlowStore {
  return createYouPetFlowStore({
    flows: runtimeState.openSyncKeyedStore<YouPetFlowRecord>({
      namespace: YOUPET_FLOW_STORE_NAMESPACE,
      maxEntries: YOUPET_FLOW_STORE_MAX_ENTRIES,
    }),
    processedEvents: runtimeState.openSyncKeyedStore<YouPetProcessedEventRecord>({
      namespace: YOUPET_PROCESSED_EVENT_STORE_NAMESPACE,
      maxEntries: YOUPET_PROCESSED_EVENT_STORE_MAX_ENTRIES,
    }),
  });
}

export function createYouPetFlowStore(stores: YouPetFlowStoreStores): YouPetFlowStore {
  return {
    recordHealthPlanActivated(params) {
      const flowKey = toYouPetFlowPlanKey(params.planId);
      const processedKey = toYouPetProcessedEventKey(params.eventId);
      const existingProcessedEvent = stores.processedEvents.lookup(processedKey);
      if (existingProcessedEvent) {
        const existingFlow = stores.flows.lookup(flowKey);
        if (!existingFlow) {
          throw new Error("YouPet flow ledger references a missing flow record");
        }
        return existingFlow;
      }

      let flow = stores.flows.lookup(flowKey);
      if (!flow) {
        const now = new Date().toISOString();
        const nextFlow = createActiveFlowRecord({
          eventId: params.eventId,
          planId: params.planId,
          petId: params.petId,
          correlationId: params.correlationId,
          now,
        });
        // Flow identity is plan-scoped: later slices write this stable id back to
        // Core, so redelivery must not replace an existing plan flow.
        stores.flows.registerIfAbsent(flowKey, nextFlow);
        flow = stores.flows.lookup(flowKey) ?? nextFlow;
      }

      const processedAt = new Date().toISOString();
      // The ledger is event-scoped; recording it once keeps outbox redelivery
      // from replaying activation work or future check-in advancement.
      stores.processedEvents.registerIfAbsent(processedKey, {
        event_id: params.eventId,
        flow_id: flow.flow_id,
        event_type: params.eventType,
        aggregate_id: params.aggregateId,
        processed_at: processedAt,
      });
      return flow;
    },
    lookupFlowByPlanId(planId) {
      return stores.flows.lookup(toYouPetFlowPlanKey(planId));
    },
    lookupProcessedEvent(eventId) {
      return stores.processedEvents.lookup(toYouPetProcessedEventKey(eventId));
    },
  };
}

export function toYouPetFlowPlanKey(planId: string): string {
  return `flow.plan.${planId}`;
}

export function toYouPetProcessedEventKey(eventId: string): string {
  return `processed.${eventId}`;
}

function createActiveFlowRecord(params: {
  eventId: string;
  planId: string;
  petId?: string;
  correlationId: string | null;
  now: string;
}): YouPetFlowRecord {
  return {
    flow_id: randomUUID(),
    plan_id: params.planId,
    ...(params.petId ? { pet_id: params.petId } : {}),
    status: "active",
    correlation_id: params.correlationId,
    created_from_event_id: params.eventId,
    checkin_count: 0,
    last_checkin_at: null,
    created_at: params.now,
    updated_at: params.now,
  };
}
