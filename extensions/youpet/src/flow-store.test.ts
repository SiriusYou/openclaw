import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
} from "../test/flow-store.fixture.js";

afterEach(async () => {
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPet flow store", () => {
  it("creates one active flow per Core health plan and records the processed event", () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );

    const first = flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });
    const replay = flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });

    expect(first.flow_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(replay.flow_id).toBe(first.flow_id);
    expect(flows.entries()).toHaveLength(1);
    expect(processedEvents.entries()).toHaveLength(1);
    expect(flowStore.lookupFlowByPlanId("plan-1")).toMatchObject({
      flow_id: first.flow_id,
      plan_id: "plan-1",
      pet_id: "pet-1",
      status: "active",
      correlation_id: "corr-1",
      created_from_event_id: "evt-health-plan-1",
      checkin_count: 0,
      last_checkin_at: null,
    });
    expect(flowStore.lookupProcessedEvent("evt-health-plan-1")).toMatchObject({
      event_id: "evt-health-plan-1",
      flow_id: first.flow_id,
      event_type: "health_plan.activated",
      aggregate_id: "plan-1",
    });
  });

  it("keeps the existing flow id when a later activation event names the same plan", () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );

    const first = flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });
    const second = flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-2",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-2",
    });

    expect(second.flow_id).toBe(first.flow_id);
    expect(flows.entries()).toHaveLength(1);
    expect(processedEvents.entries()).toHaveLength(2);
    expect(flowStore.lookupFlowByPlanId("plan-1")?.correlation_id).toBe("corr-1");
  });

  it("persists flow and ledger records across store close and reopen", async () => {
    const env = createYouPetTempStateEnv();
    const firstStore = createYouPetTestFlowStore(env).flowStore;
    const created = firstStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });

    resetPluginStateStoreForTests();

    const reopenedStore = createYouPetTestFlowStore(env).flowStore;
    expect(reopenedStore.lookupFlowByPlanId("plan-1")).toEqual(created);
    expect(reopenedStore.lookupProcessedEvent("evt-health-plan-1")).toMatchObject({
      event_id: "evt-health-plan-1",
      flow_id: created.flow_id,
      event_type: "health_plan.activated",
    });
  });
});
