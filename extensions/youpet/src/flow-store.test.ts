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
      core_linked: false,
      core_linked_at: null,
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

  it("marks a flow as linked to Core without mutating the original record", () => {
    const { flowStore, flows } = createYouPetTestFlowStore(createYouPetTempStateEnv());

    const created = flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });
    const linked = flowStore.markFlowCoreLinked("plan-1");
    const replay = flowStore.markFlowCoreLinked("plan-1");

    expect(created.core_linked).toBe(false);
    expect(created.core_linked_at).toBeNull();
    expect(linked).not.toBe(created);
    expect(linked).toMatchObject({
      flow_id: created.flow_id,
      plan_id: "plan-1",
      core_linked: true,
    });
    expect(linked.core_linked_at).toEqual(expect.any(String));
    expect(linked.updated_at).toBe(linked.core_linked_at);
    expect(replay).toEqual(linked);
    expect(flows.entries()).toHaveLength(1);
  });

  it("advances an existing flow once per distinct check-in event", () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );
    const created = flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });

    const advanced = flowStore.recordTaskCheckin({
      eventId: "evt-checkin-1",
      eventType: "task.checkin_received",
      aggregateId: "checkin-1",
      planId: "plan-1",
      checkinId: "checkin-1",
      petId: "pet-1",
      correlationId: "corr-checkin",
    });
    const replay = flowStore.recordTaskCheckin({
      eventId: "evt-checkin-1",
      eventType: "task.checkin_received",
      aggregateId: "checkin-1",
      planId: "plan-1",
      checkinId: "checkin-1",
      petId: "pet-1",
      correlationId: "corr-checkin",
    });
    const secondCheckin = flowStore.recordTaskCheckin({
      eventId: "evt-checkin-2",
      eventType: "task.checkin_received",
      aggregateId: "checkin-2",
      planId: "plan-1",
      checkinId: "checkin-2",
      petId: "pet-1",
      correlationId: "corr-checkin-2",
    });

    expect(advanced).toMatchObject({
      flow_id: created.flow_id,
      plan_id: "plan-1",
      checkin_count: 1,
      status: "active",
    });
    expect(advanced.last_checkin_at).toEqual(expect.any(String));
    expect(advanced.updated_at).toBe(advanced.last_checkin_at);
    expect(replay).toEqual(advanced);
    expect(secondCheckin).toMatchObject({
      flow_id: created.flow_id,
      plan_id: "plan-1",
      checkin_count: 2,
      status: "active",
    });
    expect(flows.entries()).toHaveLength(1);
    expect(processedEvents.entries()).toHaveLength(3);
    expect(flowStore.lookupProcessedEvent("evt-checkin-1")).toMatchObject({
      event_id: "evt-checkin-1",
      flow_id: created.flow_id,
      event_type: "task.checkin_received",
      aggregate_id: "checkin-1",
    });
    expect(flowStore.lookupProcessedEvent("evt-checkin-2")).toMatchObject({
      event_id: "evt-checkin-2",
      flow_id: created.flow_id,
      event_type: "task.checkin_received",
      aggregate_id: "checkin-2",
    });
  });

  it("lazy-creates a flow from an out-of-order check-in event", () => {
    const { flowStore, flows, processedEvents } = createYouPetTestFlowStore(
      createYouPetTempStateEnv(),
    );

    const flow = flowStore.recordTaskCheckin({
      eventId: "evt-checkin-1",
      eventType: "task.checkin_received",
      aggregateId: "checkin-1",
      planId: "plan-1",
      checkinId: "checkin-1",
      petId: "pet-1",
      correlationId: "corr-checkin",
    });

    expect(flow).toMatchObject({
      plan_id: "plan-1",
      pet_id: "pet-1",
      status: "active",
      core_linked: false,
      core_linked_at: null,
      correlation_id: "corr-checkin",
      created_from_event_id: "evt-checkin-1",
      checkin_count: 1,
    });
    expect(flow.last_checkin_at).toEqual(expect.any(String));
    expect(flows.entries()).toHaveLength(1);
    expect(processedEvents.entries()).toHaveLength(1);
  });

  it("preserves Core link state while advancing check-ins", () => {
    const { flowStore } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    flowStore.recordHealthPlanActivated({
      eventId: "evt-health-plan-1",
      eventType: "health_plan.activated",
      aggregateId: "plan-1",
      planId: "plan-1",
      petId: "pet-1",
      correlationId: "corr-1",
    });
    const linked = flowStore.markFlowCoreLinked("plan-1");

    const advanced = flowStore.recordTaskCheckin({
      eventId: "evt-checkin-1",
      eventType: "task.checkin_received",
      aggregateId: "checkin-1",
      planId: "plan-1",
      checkinId: "checkin-1",
      petId: "pet-1",
      correlationId: "corr-checkin",
    });

    expect(advanced).toMatchObject({
      flow_id: linked.flow_id,
      core_linked: true,
      core_linked_at: linked.core_linked_at,
      checkin_count: 1,
    });
  });

  it("rejects replay ledgers that reference a missing check-in flow", () => {
    const { flowStore, processedEvents } = createYouPetTestFlowStore(createYouPetTempStateEnv());
    processedEvents.register("processed.evt-checkin-1", {
      event_id: "evt-checkin-1",
      flow_id: "missing-flow",
      event_type: "task.checkin_received",
      aggregate_id: "checkin-1",
      processed_at: "2026-06-01T00:00:00Z",
    });

    expect(() =>
      flowStore.recordTaskCheckin({
        eventId: "evt-checkin-1",
        eventType: "task.checkin_received",
        aggregateId: "checkin-1",
        planId: "plan-1",
        checkinId: "checkin-1",
        petId: "pet-1",
        correlationId: "corr-checkin",
      }),
    ).toThrow("YouPet flow ledger references a missing flow record");
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
