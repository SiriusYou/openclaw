import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createYouPetActionRequestCursorStore,
  YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
  YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE,
  type YouPetActionRequestCursorRecord,
  type YouPetActionRequestCursorStore,
} from "../src/action-request-cursor-store.js";
import {
  createYouPetFlowStore,
  YOUPET_FLOW_STORE_MAX_ENTRIES,
  YOUPET_FLOW_STORE_NAMESPACE,
  YOUPET_PROCESSED_EVENT_STORE_MAX_ENTRIES,
  YOUPET_PROCESSED_EVENT_STORE_NAMESPACE,
  type YouPetFlowRecord,
  type YouPetFlowStore,
  type YouPetProcessedEventRecord,
} from "../src/flow-store.js";

const tempStateDirs: string[] = [];

export type YouPetTestFlowStore = {
  flowStore: YouPetFlowStore;
  actionRequestCursorStore: YouPetActionRequestCursorStore;
  flows: PluginStateSyncKeyedStore<YouPetFlowRecord>;
  actionRequestCursors: PluginStateSyncKeyedStore<YouPetActionRequestCursorRecord>;
  processedEvents: PluginStateSyncKeyedStore<YouPetProcessedEventRecord>;
};

export function createYouPetTestFlowStore(
  env?: Record<string, string | undefined>,
): YouPetTestFlowStore {
  const actionRequestCursors =
    createPluginStateSyncKeyedStoreForTests<YouPetActionRequestCursorRecord>("youpet", {
      namespace: YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE,
      maxEntries: YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
      ...(env ? { env } : {}),
    });
  const flows = createPluginStateSyncKeyedStoreForTests<YouPetFlowRecord>("youpet", {
    namespace: YOUPET_FLOW_STORE_NAMESPACE,
    maxEntries: YOUPET_FLOW_STORE_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
  const processedEvents = createPluginStateSyncKeyedStoreForTests<YouPetProcessedEventRecord>(
    "youpet",
    {
      namespace: YOUPET_PROCESSED_EVENT_STORE_NAMESPACE,
      maxEntries: YOUPET_PROCESSED_EVENT_STORE_MAX_ENTRIES,
      ...(env ? { env } : {}),
    },
  );
  return {
    actionRequestCursorStore: createYouPetActionRequestCursorStore(actionRequestCursors),
    actionRequestCursors,
    flowStore: createYouPetFlowStore({ flows, processedEvents }),
    flows,
    processedEvents,
  };
}

export function createYouPetTestRuntimeState(env?: Record<string, string | undefined>): {
  openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<T>;
} {
  return {
    openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("youpet", {
        ...options,
        ...(env ? { env } : {}),
      }),
  };
}

export function createYouPetTempStateEnv(): Record<string, string | undefined> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "youpet-flow-state-"));
  tempStateDirs.push(stateDir);
  return { OPENCLAW_STATE_DIR: stateDir };
}

export async function cleanupYouPetTempStateDirs(): Promise<void> {
  await Promise.all(
    tempStateDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
  tempStateDirs.length = 0;
}
