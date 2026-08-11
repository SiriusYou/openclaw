import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import {
  cleanupYouPetTempStateDirs,
  createYouPetTempStateEnv,
  createYouPetTestFlowStore,
  createYouPetTestRuntimeState,
} from "../test/flow-store.fixture.js";
import { YouPetOutboxConsumer } from "./outbox-consumer.js";

const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const OPERATOR_ID = "00000000-0000-0000-0000-000000000002";
const execFileAsync = promisify(execFile);

type ConsumerAuthEntry = {
  token: string;
  actor_id: string;
  outbox_lane?: string | null;
};

type ConsumerAuthMap = Record<string, ConsumerAuthEntry>;

type SmokeConfig = {
  coreBaseUrl: string;
  tenantId: string;
  consumerAuth: ConsumerAuthMap & {
    hermes: ConsumerAuthEntry;
    openclaw: ConsumerAuthEntry;
    openhuman: ConsumerAuthEntry;
  };
};

type CoreActionRequestEnvelope = {
  action_request: {
    id: string;
    target: { type: string; id: string };
    action_type: string;
    approval: { state: string };
    execution: { state: string };
  };
  row_version: number;
};

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  status?: number;
  ok?: boolean;
};

type CoreOutboxItem = {
  event_id: string;
  event_type: string;
  payload: unknown;
};

type CoreOutboxResponse = {
  items?: unknown[];
};

type CoreHealthPlanResponse = {
  id: string;
  pet_id: string;
  openclaw_flow_id?: string | null;
};

const smokeIt = process.env.YOUPET_M2_FLOW_SMOKE === "1" ? it : it.skip;
const recoverySmokeIt =
  process.env.YOUPET_M2_FLOW_SMOKE === "1" && process.env.YOUPET_DATABASE_URL ? it : it.skip;

afterEach(async () => {
  vi.unstubAllGlobals();
  resetPluginStateStoreForTests();
  await cleanupYouPetTempStateDirs();
});

describe("YouPet M2 OpenClaw flow live smoke", () => {
  it("fails loudly when the live smoke flag is set without required env", () => {
    expect(() => readSmokeConfig({ YOUPET_M2_FLOW_SMOKE: "1" })).toThrow(/YOUPET_CORE_BASE_URL/);
    expect(() =>
      readSmokeConfig({
        YOUPET_M2_FLOW_SMOKE: "1",
        YOUPET_CORE_BASE_URL: "http://127.0.0.1:18080",
        YOUPET_TENANT_ID: "00000000-0000-4000-8000-000000000101",
      }),
    ).toThrow(/YOUPET_CONSUMER_AUTH/);
    expect(() =>
      readSmokeConfig({
        YOUPET_M2_FLOW_SMOKE: "1",
        YOUPET_CORE_BASE_URL: "http://127.0.0.1:18080",
        YOUPET_CONSUMER_AUTH: JSON.stringify({
          hermes: {
            token: "hermes-token",
            actor_id: "hermes-wecom-bridge",
            outbox_lane: "openclaw",
          },
          openclaw: {
            token: "openclaw-token",
            actor_id: "openclaw-youpet-consumer",
            outbox_lane: "openclaw",
          },
          openhuman: {
            token: "openhuman-token",
            actor_id: "openhuman-workbench",
          },
        }),
      }),
    ).toThrow(/YOUPET_TENANT_ID/);
    expect(() =>
      readSmokeConfig({
        YOUPET_M2_FLOW_SMOKE: "1",
        YOUPET_CORE_BASE_URL: "http://127.0.0.1:18080",
        YOUPET_TENANT_ID: "00000000-0000-4000-8000-000000000101",
        YOUPET_CONSUMER_AUTH: JSON.stringify({
          hermes: {
            token: "hermes-token",
            actor_id: "hermes-wecom-bridge",
            outbox_lane: "openclaw",
          },
          openclaw: {
            token: "openclaw-token",
            actor_id: "openclaw-youpet-consumer",
            outbox_lane: "openclaw",
          },
          openhuman: {
            token: "openhuman-token",
            actor_id: "openhuman-workbench",
          },
        }),
      }),
    ).toThrow(/hermes.*outbox_lane/);
  });

  smokeIt("runs the M2 flow adapter against live Core HTTP", async () => {
    const config = readSmokeConfig(process.env);
    if (!config) {
      throw new Error("YOUPET_M2_FLOW_SMOKE=1 is required for this smoke");
    }
    const runId = randomUUID();
    const originalFetch = globalThis.fetch.bind(globalThis);

    const pet = await requestJson<{ id: string }>(
      config,
      config.consumerAuth.hermes,
      "/api/v1/pets",
      {
        method: "POST",
        body: {
          owner_user_id: OWNER_ID,
          name: `M2 Smoke Cat ${runId.slice(0, 8)}`,
          species: "cat",
          breed: "Exotic Shorthair",
          weight_kg: 3.8,
        },
        idempotencyKey: `${runId}:pet`,
        fetchFn: originalFetch,
      },
    );

    const plan = await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.hermes,
      "/api/v1/health-plans",
      {
        method: "POST",
        body: {
          pet_id: pet.id,
          plan_type: "deworming",
          title: `M2 smoke deworming ${runId.slice(0, 8)}`,
          start_at: new Date(Date.now() + 60_000).toISOString(),
          schedule_rule: "FREQ=DAILY;INTERVAL=1",
          reminder_times: ["09:00"],
          missed_threshold: 1,
        },
        idempotencyKey: `${runId}:plan`,
        fetchFn: originalFetch,
      },
    );

    await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.hermes,
      `/api/v1/health-plans/${encodeURIComponent(plan.id)}/activate`,
      {
        method: "POST",
        idempotencyKey: `${runId}:activate`,
        correlationId: `m2-smoke-${runId}`,
        fetchFn: originalFetch,
      },
    );

    const flowHermesPull = await pullHermesDeliveries(
      config,
      config.consumerAuth.hermes,
      plan.id,
      originalFetch,
    );
    await Promise.all(
      flowHermesPull.claimedEventIds.map((eventId) =>
        requestJson<unknown>(
          config,
          config.consumerAuth.hermes,
          `/internal/events/outbox/${encodeURIComponent(eventId)}/ack`,
          {
            method: "POST",
            query: { consumer: "hermes" },
            idempotencyKey: `${runId}:ack-hermes:${eventId}`,
            fetchFn: originalFetch,
          },
        ),
      ),
    );

    const env = createYouPetTempStateEnv();
    const runtimeState = createYouPetTestRuntimeState(env);
    const openSyncKeyedStore = vi.fn(runtimeState.openSyncKeyedStore);
    const registerService = vi.fn();
    const recordedRequests: RecordedRequest[] = [];
    const serviceLogProbe = createServiceLogProbe();
    vi.stubGlobal(
      "fetch",
      createRecordingFetch(config.coreBaseUrl, originalFetch, recordedRequests),
    );

    plugin.register(
      createTestPluginApi({
        id: "youpet",
        name: "YouPet Core",
        source: "test",
        pluginConfig: {
          enabled: true,
          coreBaseUrl: config.coreBaseUrl,
          serviceToken: config.consumerAuth.openclaw.token,
          tenantId: config.tenantId,
          actorId: config.consumerAuth.openclaw.actor_id,
          pollIntervalMs: 60_000,
        },
        runtime: { state: { openSyncKeyedStore } } as never,
        registerService,
      }),
    );
    const service = registerService.mock.calls.at(0)?.at(0);
    if (!service) {
      throw new Error("expected youpet plugin to register the outbox service");
    }

    const flowStore = createYouPetTestFlowStore(env).flowStore;
    try {
      service.start({
        logger: serviceLogProbe.logger,
        stateDir: "",
        config: {},
      });
      await waitFor(
        () =>
          flowStore.lookupFlowByPlanId(plan.id)?.core_linked === true &&
          successfulAckRequests(recordedRequests).length === 1,
      );
    } finally {
      service.stop?.();
    }

    const activatedFlow = flowStore.lookupFlowByPlanId(plan.id);
    expect(activatedFlow).toMatchObject({
      plan_id: plan.id,
      pet_id: pet.id,
      core_linked: true,
      checkin_count: 0,
    });
    expect(activatedFlow?.flow_id).toBeTypeOf("string");
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(2);
    expect(nackRequests(recordedRequests)).toHaveLength(0);
    expect(failedAckRequests(recordedRequests)).toHaveLength(0);
    expect(successfulAckRequests(recordedRequests)).toHaveLength(1);
    expect(serviceLogProbe.problems).toEqual([]);

    const activationFlowPosts = flowWritebackRequests(recordedRequests, plan.id);
    expect(activationFlowPosts).toHaveLength(1);
    expect(activationFlowPosts[0]).toMatchObject({
      method: "POST",
      body: { openclaw_flow_id: activatedFlow?.flow_id },
    });

    const replay = await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.openclaw,
      `/api/v1/health-plans/${encodeURIComponent(plan.id)}/flow`,
      {
        method: "POST",
        body: { openclaw_flow_id: activatedFlow?.flow_id },
        idempotencyKey: `${runId}:flow-replay`,
        fetchFn: originalFetch,
      },
    );
    expect(replay.openclaw_flow_id).toBe(activatedFlow?.flow_id);

    await requestJson<unknown>(
      config,
      config.consumerAuth.hermes,
      `/api/v1/tasks/${encodeURIComponent(flowHermesPull.taskId)}/checkin`,
      {
        method: "POST",
        body: {
          submitted_by: OWNER_ID,
          text: "M2 smoke check-in completed. Looks normal.",
          status_tags: ["completed", "normal"],
          media_asset_ids: [],
        },
        idempotencyKey: `${runId}:checkin`,
        correlationId: `m2-smoke-checkin-${runId}`,
        fetchFn: originalFetch,
      },
    );

    const flowWritebacksBeforeCheckin = flowWritebackRequests(recordedRequests, plan.id).length;
    const ackCountBeforeCheckin = successfulAckRequests(recordedRequests).length;
    try {
      service.start({
        logger: serviceLogProbe.logger,
        stateDir: "",
        config: {},
      });
      await waitFor(
        () =>
          flowStore.lookupFlowByPlanId(plan.id)?.checkin_count === 1 &&
          successfulAckRequests(recordedRequests).length > ackCountBeforeCheckin,
      );
    } finally {
      service.stop?.();
    }

    const checkedInFlow = flowStore.lookupFlowByPlanId(plan.id);
    expect(checkedInFlow).toMatchObject({
      flow_id: activatedFlow?.flow_id,
      plan_id: plan.id,
      pet_id: pet.id,
      core_linked: true,
      checkin_count: 1,
    });
    expect(flowWritebackRequests(recordedRequests, plan.id)).toHaveLength(
      flowWritebacksBeforeCheckin,
    );
    expect(nackRequests(recordedRequests)).toHaveLength(0);
    expect(failedAckRequests(recordedRequests)).toHaveLength(0);
    expect(successfulAckRequests(recordedRequests).length).toBeGreaterThan(ackCountBeforeCheckin);
    expect(serviceLogProbe.problems).toEqual([]);

    const taskPlan = await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.hermes,
      "/api/v1/health-plans",
      {
        method: "POST",
        body: {
          pet_id: pet.id,
          plan_type: "deworming",
          title: `M2 smoke escalation ${runId.slice(0, 8)}`,
          start_at: new Date(Date.now() + 120_000).toISOString(),
          schedule_rule: "FREQ=DAILY;INTERVAL=1",
          reminder_times: ["10:00"],
          missed_threshold: 1,
        },
        idempotencyKey: `${runId}:task-plan`,
        fetchFn: originalFetch,
      },
    );
    await requestJson<CoreHealthPlanResponse>(
      config,
      config.consumerAuth.hermes,
      `/api/v1/health-plans/${encodeURIComponent(taskPlan.id)}/activate`,
      {
        method: "POST",
        idempotencyKey: `${runId}:activate-task-plan`,
        correlationId: `m2-smoke-task-plan-${runId}`,
        fetchFn: originalFetch,
      },
    );
    const taskHermesPull = await pullHermesDeliveries(
      config,
      config.consumerAuth.hermes,
      taskPlan.id,
      originalFetch,
    );
    await Promise.all(
      taskHermesPull.claimedEventIds.map((eventId) =>
        requestJson<unknown>(
          config,
          config.consumerAuth.hermes,
          `/internal/events/outbox/${encodeURIComponent(eventId)}/ack`,
          {
            method: "POST",
            query: { consumer: "hermes" },
            idempotencyKey: `${runId}:ack-task-plan:${eventId}`,
            fetchFn: originalFetch,
          },
        ),
      ),
    );

    const taskPlanProposalCount = actionRequestCreateRequests(recordedRequests).length;
    const taskPlanAckCount = successfulAckRequests(recordedRequests).length;
    try {
      service.start({ logger: serviceLogProbe.logger, stateDir: "", config: {} });
      await waitFor(
        () =>
          flowStore.lookupFlowByPlanId(taskPlan.id)?.core_linked === true &&
          actionRequestCreateRequests(recordedRequests).length > taskPlanProposalCount &&
          successfulAckRequests(recordedRequests).length > taskPlanAckCount,
      );
    } finally {
      service.stop?.();
    }

    await requestJson<unknown>(
      config,
      config.consumerAuth.hermes,
      `/api/v1/tasks/${encodeURIComponent(taskHermesPull.taskId)}/missed`,
      {
        method: "POST",
        idempotencyKey: `${runId}:missed`,
        correlationId: `m2-smoke-missed-${runId}`,
        fetchFn: originalFetch,
      },
    );

    const proposalCountBeforeMissed = actionRequestCreateRequests(recordedRequests).length;
    const ackCountBeforeMissed = successfulAckRequests(recordedRequests).length;
    try {
      service.start({ logger: serviceLogProbe.logger, stateDir: "", config: {} });
      await waitFor(
        () =>
          actionRequestCreateRequests(recordedRequests).length > proposalCountBeforeMissed &&
          successfulAckRequests(recordedRequests).length > ackCountBeforeMissed,
      );
    } finally {
      service.stop?.();
    }

    const pending = await requestJson<{ items: CoreActionRequestEnvelope[] }>(
      config,
      config.consumerAuth.openclaw,
      "/api/v1/action-requests",
      {
        query: {
          tenant_id: config.tenantId,
          approval_state: "pending",
          execution_state: "not_started",
          limit: "200",
        },
        fetchFn: originalFetch,
      },
    );
    const taskEscalation = pending.items.find(
      (item) =>
        item.action_request.action_type === "task.escalate" &&
        item.action_request.target.type === "task_instance" &&
        item.action_request.target.id === taskHermesPull.taskId,
    );
    if (!taskEscalation) {
      throw new Error("expected pending task escalation ActionRequest");
    }

    await requestJson<CoreActionRequestEnvelope>(
      config,
      config.consumerAuth.openhuman,
      `/api/v1/action-requests/${encodeURIComponent(taskEscalation.action_request.id)}/approve`,
      {
        method: "POST",
        body: {
          decided_by: { type: "user", id: OPERATOR_ID },
          reason: "M2 live smoke approval",
          expected_row_version: taskEscalation.row_version,
        },
        idempotencyKey: `${runId}:approve-task-escalation`,
        fetchFn: originalFetch,
      },
    );

    const escalationCountBeforeDispatch = taskEscalationRequests(
      recordedRequests,
      taskHermesPull.taskId,
    ).length;
    try {
      service.start({ logger: serviceLogProbe.logger, stateDir: "", config: {} });
      await waitFor(
        () =>
          taskEscalationRequests(recordedRequests, taskHermesPull.taskId).length >
            escalationCountBeforeDispatch &&
          successfulExecutionStatusRequests(
            recordedRequests,
            taskEscalation.action_request.id,
            "succeeded",
          ).length === 1,
      );
    } finally {
      service.stop?.();
    }

    const executedTaskEscalation = await requestJson<CoreActionRequestEnvelope>(
      config,
      config.consumerAuth.openclaw,
      `/api/v1/action-requests/${encodeURIComponent(taskEscalation.action_request.id)}`,
      { fetchFn: originalFetch },
    );
    expect(executedTaskEscalation.action_request.execution.state).toBe("succeeded");
    expect(taskEscalationRequests(recordedRequests, taskHermesPull.taskId)).toHaveLength(1);
    expect(nackRequests(recordedRequests)).toHaveLength(0);
    expect(failedAckRequests(recordedRequests)).toHaveLength(0);
    expect(serviceLogProbe.problems).toEqual([]);
  });

  recoverySmokeIt(
    "recovers a claimed live Core ActionRequest through the legacy both-null bridge",
    async () => {
      const config = readSmokeConfig(process.env);
      if (!config) {
        throw new Error("YOUPET_M2_FLOW_SMOKE=1 is required for this smoke");
      }
      const databaseUrl = readRequiredEnv(process.env, "YOUPET_DATABASE_URL");
      const runId = randomUUID();
      const workerId = `m2-recovery-${runId.slice(0, 8)}`;
      const originalFetch = globalThis.fetch.bind(globalThis);

      const pet = await requestJson<{ id: string }>(
        config,
        config.consumerAuth.hermes,
        "/api/v1/pets",
        {
          method: "POST",
          body: {
            owner_user_id: OWNER_ID,
            name: `M2 Recovery Cat ${runId.slice(0, 8)}`,
            species: "cat",
            breed: "American Shorthair",
            weight_kg: 4.2,
          },
          idempotencyKey: `${runId}:pet`,
          fetchFn: originalFetch,
        },
      );

      const plan = await requestJson<CoreHealthPlanResponse>(
        config,
        config.consumerAuth.hermes,
        "/api/v1/health-plans",
        {
          method: "POST",
          body: {
            pet_id: pet.id,
            plan_type: "deworming",
            title: `M2 recovery ${runId.slice(0, 8)}`,
            start_at: new Date(Date.now() + 90_000).toISOString(),
            schedule_rule: "FREQ=DAILY;INTERVAL=1",
            reminder_times: ["11:00"],
            missed_threshold: 1,
          },
          idempotencyKey: `${runId}:plan`,
          fetchFn: originalFetch,
        },
      );

      await requestJson<CoreHealthPlanResponse>(
        config,
        config.consumerAuth.hermes,
        `/api/v1/health-plans/${encodeURIComponent(plan.id)}/activate`,
        {
          method: "POST",
          idempotencyKey: `${runId}:activate`,
          correlationId: `m2-recovery-${runId}`,
          fetchFn: originalFetch,
        },
      );

      const taskHermesPull = await pullHermesDeliveries(
        config,
        config.consumerAuth.hermes,
        plan.id,
        originalFetch,
      );
      await Promise.all(
        taskHermesPull.claimedEventIds.map((eventId) =>
          requestJson<unknown>(
            config,
            config.consumerAuth.hermes,
            `/internal/events/outbox/${encodeURIComponent(eventId)}/ack`,
            {
              method: "POST",
              query: { consumer: "hermes" },
              idempotencyKey: `${runId}:ack-hermes:${eventId}`,
              fetchFn: originalFetch,
            },
          ),
        ),
      );

      const proposalConsumer = new YouPetOutboxConsumer({
        coreBaseUrl: config.coreBaseUrl,
        serviceToken: config.consumerAuth.openclaw.token,
        tenantId: config.tenantId,
        actorId: config.consumerAuth.openclaw.actor_id,
        workerId,
        fetchFn: originalFetch,
        manageFlows: false,
      });
      await proposalConsumer.pollOnce();

      await requestJson<unknown>(
        config,
        config.consumerAuth.hermes,
        `/api/v1/tasks/${encodeURIComponent(taskHermesPull.taskId)}/missed`,
        {
          method: "POST",
          idempotencyKey: `${runId}:missed`,
          correlationId: `m2-recovery-missed-${runId}`,
          fetchFn: originalFetch,
        },
      );
      await proposalConsumer.pollOnce();

      const pending = await requestJson<{ items: CoreActionRequestEnvelope[] }>(
        config,
        config.consumerAuth.openclaw,
        "/api/v1/action-requests",
        {
          query: {
            tenant_id: config.tenantId,
            approval_state: "pending",
            execution_state: "not_started",
            limit: "200",
          },
          fetchFn: originalFetch,
        },
      );
      const taskEscalation = pending.items.find(
        (item) =>
          item.action_request.action_type === "task.escalate" &&
          item.action_request.target.type === "task_instance" &&
          item.action_request.target.id === taskHermesPull.taskId,
      );
      if (!taskEscalation) {
        throw new Error("expected pending task escalation ActionRequest for recovery smoke");
      }

      const approved = await requestJson<CoreActionRequestEnvelope>(
        config,
        config.consumerAuth.openhuman,
        `/api/v1/action-requests/${encodeURIComponent(taskEscalation.action_request.id)}/approve`,
        {
          method: "POST",
          body: {
            decided_by: { type: "user", id: OPERATOR_ID },
            reason: "M2 recovery live smoke approval",
            expected_row_version: taskEscalation.row_version,
          },
          idempotencyKey: `${runId}:approve`,
          fetchFn: originalFetch,
        },
      );
      const queued = await requestJson<CoreActionRequestEnvelope>(
        config,
        config.consumerAuth.openclaw,
        `/api/v1/action-requests/${encodeURIComponent(taskEscalation.action_request.id)}/execution-status`,
        {
          method: "POST",
          body: {
            state: "queued",
            expected_row_version: approved.row_version,
          },
          idempotencyKey: `${runId}:queue`,
          fetchFn: originalFetch,
        },
      );
      await requestJson<CoreActionRequestEnvelope>(
        config,
        config.consumerAuth.openclaw,
        `/api/v1/action-requests/${encodeURIComponent(taskEscalation.action_request.id)}/execution-claim`,
        {
          method: "POST",
          body: {
            worker_id: workerId,
            expected_row_version: queued.row_version,
          },
          idempotencyKey: `${runId}:claim`,
          fetchFn: originalFetch,
        },
      );

      await forceActionRequestRecoveryBridge(databaseUrl, taskEscalation.action_request.id);

      const recoveryRequests: RecordedRequest[] = [];
      const recoveryConsumer = new YouPetOutboxConsumer({
        coreBaseUrl: config.coreBaseUrl,
        serviceToken: config.consumerAuth.openclaw.token,
        tenantId: config.tenantId,
        actorId: config.consumerAuth.openclaw.actor_id,
        workerId: `dispatcher-${workerId}`,
        fetchFn: createRecordingFetch(config.coreBaseUrl, originalFetch, recoveryRequests),
        manageFlows: false,
      });

      const result = await recoveryConsumer.dispatchActionRequestsOnce();

      expect(result).toMatchObject({
        failed: 1,
        claimed: 0,
        succeeded: 0,
        conflicted: 0,
        errored: 0,
      });
      expect(taskEscalationRequests(recoveryRequests, taskHermesPull.taskId)).toHaveLength(0);
      const failedExecution = successfulExecutionStatusRequests(
        recoveryRequests,
        taskEscalation.action_request.id,
        "failed",
      );
      expect(failedExecution).toHaveLength(1);
      expect(failedExecution[0]?.body).toMatchObject({
        state: "failed",
        error: {
          code: "execution_authorization_expired",
          message: "policy expired before execution completed",
        },
      });
      expect(failedExecution[0]?.body).not.toHaveProperty("worker_id");

      const recovered = await requestJson<CoreActionRequestEnvelope>(
        config,
        config.consumerAuth.openclaw,
        `/api/v1/action-requests/${encodeURIComponent(taskEscalation.action_request.id)}`,
        { fetchFn: originalFetch },
      );
      expect(recovered.action_request.execution.state).toBe("failed");
      expect(recovered.row_version).toBe(5);
      expect(recovered.execution_claim).toBeNull();
      expect(
        await countActionRequestRecoveryEvidence(databaseUrl, taskEscalation.action_request.id),
      ).toEqual({ auditCount: 1, eventCount: 1 });
      expect(
        await countActionRequestConsumerDeliveries(databaseUrl, taskEscalation.action_request.id),
      ).toBe(0);
    },
  );
});

function readSmokeConfig(env: Record<string, string | undefined>): SmokeConfig | null {
  if (env.YOUPET_M2_FLOW_SMOKE !== "1") {
    return null;
  }
  const coreBaseUrl = readRequiredEnv(env, "YOUPET_CORE_BASE_URL").replace(/\/+$/u, "");
  const tenantId = readRequiredEnv(env, "YOUPET_TENANT_ID");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tenantId)
  ) {
    throw new Error("YOUPET_TENANT_ID must be a UUID");
  }
  const consumerAuth = parseConsumerAuth(readRequiredEnv(env, "YOUPET_CONSUMER_AUTH"));
  return { coreBaseUrl, tenantId, consumerAuth };
}

function readRequiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required when YOUPET_M2_FLOW_SMOKE=1`);
  }
  return value;
}

function parseConsumerAuth(raw: string): SmokeConfig["consumerAuth"] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("YOUPET_CONSUMER_AUTH must be a JSON object");
  }
  const hermes = readConsumerAuthEntry(parsed, "hermes", "hermes");
  const openclaw = readConsumerAuthEntry(parsed, "openclaw", "openclaw");
  const openhuman = readConsumerAuthEntry(parsed, "openhuman", null);
  return { ...parsed, hermes, openclaw, openhuman } as SmokeConfig["consumerAuth"];
}

function readConsumerAuthEntry(
  auth: Record<string, unknown>,
  consumer: string,
  expectedOutboxLane: string | null,
): ConsumerAuthEntry {
  const entry = auth[consumer];
  if (!isRecord(entry)) {
    throw new Error(`YOUPET_CONSUMER_AUTH must include ${consumer}`);
  }
  const token = readString(entry.token);
  const actorId = readString(entry.actor_id);
  if (!token || !actorId) {
    throw new Error(`YOUPET_CONSUMER_AUTH.${consumer} must include token and actor_id`);
  }
  const outboxLane = readString(entry.outbox_lane);
  if (
    (expectedOutboxLane === null && outboxLane !== undefined) ||
    (expectedOutboxLane !== null && outboxLane !== expectedOutboxLane)
  ) {
    throw new Error(`YOUPET_CONSUMER_AUTH.${consumer}.outbox_lane must be ${expectedOutboxLane}`);
  }
  return {
    token,
    actor_id: actorId,
    ...(outboxLane ? { outbox_lane: outboxLane } : {}),
  };
}

async function requestJson<T>(
  config: SmokeConfig,
  auth: ConsumerAuthEntry,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    idempotencyKey?: string;
    correlationId?: string;
    fetchFn?: typeof fetch;
  } = {},
): Promise<T> {
  const url = new URL(path, `${config.coreBaseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers({
    Authorization: `Bearer ${auth.token}`,
    "X-Actor-Id": auth.actor_id,
  });
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.correlationId) {
    headers.set("X-Correlation-Id", options.correlationId);
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  const response = await (options.fetchFn ?? fetch)(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Core request failed ${response.status} ${url.pathname}: ${text}`);
  }
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

async function forceActionRequestRecoveryBridge(
  databaseUrl: string,
  actionRequestId: string,
): Promise<string> {
  const sql = `
WITH boundary AS (
  SELECT
    id,
    GREATEST(
      COALESCE(
        (document #>> '{policy,decided_at}')::timestamptz,
        (document #>> '{action_request,policy,decided_at}')::timestamptz
      ),
      clock_timestamp()
    ) AS expires_at
  FROM action_requests
  WHERE id = ${sqlStringLiteral(actionRequestId)}::uuid
), updated AS (
  UPDATE action_requests AS requests
  SET
    document = CASE
      WHEN requests.document ? 'policy' THEN
        jsonb_set(
          requests.document,
          '{policy,expires_at}',
          to_jsonb(
            to_char(
              boundary.expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          ),
          true
        )
      WHEN requests.document ? 'action_request' THEN
        jsonb_set(
          requests.document,
          '{action_request,policy,expires_at}',
          to_jsonb(
            to_char(
              boundary.expires_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          ),
          true
        )
      ELSE requests.document
    END,
    execution_owner_id = NULL,
    execution_lease_expires_at = NULL,
    updated_at = boundary.expires_at
  FROM boundary
  WHERE requests.id = boundary.id
  RETURNING requests.id, requests.document
)
SELECT CASE
  WHEN document ? 'policy' THEN document #>> '{policy,expires_at}'
  ELSE document #>> '{action_request,policy,expires_at}'
END
FROM updated;
`.trim();
  const { stdout, stderr } = await execFileAsync(
    "psql",
    [databaseUrl, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env: { ...process.env, PAGER: "cat" },
      maxBuffer: 1024 * 1024,
    },
  );
  const expiresAt = stdout.trim();
  if (!expiresAt) {
    throw new Error(
      `expected psql to expire ActionRequest ${actionRequestId}; stdout=${stdout} stderr=${stderr}`,
    );
  }
  return expiresAt;
}

async function countActionRequestConsumerDeliveries(
  databaseUrl: string,
  actionRequestId: string,
): Promise<number> {
  const sql = `
SELECT COUNT(*)
FROM outbox_deliveries deliveries
JOIN event_outbox events ON events.id = deliveries.event_id
WHERE events.aggregate_type = 'action_request'
  AND events.aggregate_id = ${sqlStringLiteral(actionRequestId)}::uuid
  AND deliveries.consumer IN ('openclaw', 'openhuman');
`.trim();
  const { stdout } = await execFileAsync(
    "psql",
    [databaseUrl, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env: { ...process.env, PAGER: "cat" },
      maxBuffer: 1024 * 1024,
    },
  );
  return Number(stdout.trim());
}

async function countActionRequestRecoveryEvidence(
  databaseUrl: string,
  actionRequestId: string,
): Promise<{ auditCount: number; eventCount: number }> {
  const sql = `
SELECT
  (
    SELECT COUNT(*)
    FROM audit_logs
    WHERE target_type = 'action_request'
      AND target_id = ${sqlStringLiteral(actionRequestId)}::uuid
      AND action = 'action_request.execution_updated'
      AND payload_json->>'execution_state' = 'failed'
  ),
  (
    SELECT COUNT(*)
    FROM event_outbox
    WHERE aggregate_type = 'action_request'
      AND aggregate_id = ${sqlStringLiteral(actionRequestId)}::uuid
      AND event_type = 'action_request.execution_updated'
      AND payload #>> '{payload,execution_state}' = 'failed'
  );
`.trim();
  const { stdout } = await execFileAsync(
    "psql",
    [databaseUrl, "-X", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env: { ...process.env, PAGER: "cat" },
      maxBuffer: 1024 * 1024,
    },
  );
  const [auditCount, eventCount] = stdout
    .trim()
    .split("|")
    .map((value) => Number(value));
  return { auditCount, eventCount };
}

async function pullHermesDeliveries(
  config: SmokeConfig,
  auth: ConsumerAuthEntry,
  planId: string,
  fetchFn: typeof fetch,
): Promise<{ claimedEventIds: string[]; taskId: string }> {
  const outbox = await requestJson<CoreOutboxResponse>(config, auth, "/internal/events/outbox", {
    query: { consumer: "hermes", limit: "50" },
    fetchFn,
  });
  const items = (outbox.items ?? []).filter(isCoreOutboxItem);
  const taskCreated = items.find((item) => {
    const payload = readBusinessPayload(item);
    return (
      item.event_type === "task.created" &&
      readString(payload?.plan_id) === planId &&
      Boolean(readString(payload?.task_id))
    );
  });
  if (!taskCreated) {
    throw new Error(`expected task.created delivery for plan ${planId}`);
  }
  const taskId = readString(readBusinessPayload(taskCreated)?.task_id);
  if (!taskId) {
    throw new Error("task.created delivery did not include payload.payload.task_id");
  }
  return { claimedEventIds: items.map((item) => item.event_id), taskId };
}

function createRecordingFetch(
  coreBaseUrl: string,
  fetchFn: typeof fetch,
  recordedRequests: RecordedRequest[],
): typeof fetch {
  const coreOrigin = new URL(coreBaseUrl).origin;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = new URL(url);
    if (parsed.origin === coreOrigin) {
      const recorded: RecordedRequest = {
        url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body:
          typeof init?.body === "string" && init.body.length > 0
            ? JSON.parse(init.body)
            : undefined,
      };
      recordedRequests.push(recorded);
      const response = await fetchFn(input, init);
      recorded.status = response.status;
      recorded.ok = response.ok;
      return response;
    }
    return await fetchFn(input, init);
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("timed out waiting for M2 smoke condition");
}

function flowWritebackRequests(requests: RecordedRequest[], planId: string): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url).pathname === `/api/v1/health-plans/${planId}/flow` &&
      request.method === "POST",
  );
}

function actionRequestCreateRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url).pathname === "/api/v1/action-requests" &&
      request.method === "POST" &&
      request.ok === true,
  );
}

function taskEscalationRequests(requests: RecordedRequest[], taskId: string): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url).pathname === `/api/v1/tasks/${taskId}/escalate` &&
      request.method === "POST" &&
      request.ok === true,
  );
}

function successfulExecutionStatusRequests(
  requests: RecordedRequest[],
  actionRequestId: string,
  state: string,
): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url).pathname ===
        `/api/v1/action-requests/${actionRequestId}/execution-status` &&
      request.method === "POST" &&
      request.ok === true &&
      isRecord(request.body) &&
      request.body.state === state,
  );
}

function ackRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => new URL(request.url).pathname.endsWith("/ack"));
}

function successfulAckRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return ackRequests(requests).filter((request) => request.ok === true);
}

function failedAckRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return ackRequests(requests).filter((request) => request.ok === false);
}

function nackRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => new URL(request.url).pathname.endsWith("/nack"));
}

function createServiceLogProbe(): {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  problems: string[];
} {
  const problems: string[] = [];
  return {
    logger: {
      info: vi.fn(),
      warn: (...args: unknown[]) => {
        const message = formatLogArgs(args);
        problems.push(`warn: ${message}`);
        console.warn(...args);
      },
      error: (...args: unknown[]) => {
        const message = formatLogArgs(args);
        problems.push(`error: ${message}`);
        console.error(...args);
      },
    },
    problems,
  };
}

function formatLogArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
}

function isCoreOutboxItem(value: unknown): value is CoreOutboxItem {
  return (
    isRecord(value) &&
    typeof value.event_id === "string" &&
    typeof value.event_type === "string" &&
    "payload" in value
  );
}

function readBusinessPayload(item: CoreOutboxItem): Record<string, unknown> | undefined {
  if (!isRecord(item.payload) || !isRecord(item.payload.payload)) {
    return undefined;
  }
  return item.payload.payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
