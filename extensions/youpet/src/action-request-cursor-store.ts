import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE = "action-request-cursors";
export const YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES = 32;

export type YouPetActionRequestCursorRecord = {
  next_cursor: string;
};

export type YouPetActionRequestCursorStore = {
  load(params: {
    tenantId: string;
    actorId: string;
    approvalState: "approved" | "not_required";
    executionState: "running" | "queued" | "not_started";
  }): string | undefined;
  save(params: {
    tenantId: string;
    actorId: string;
    approvalState: "approved" | "not_required";
    executionState: "running" | "queued" | "not_started";
    nextCursor: string;
  }): void;
  clear(params: {
    tenantId: string;
    actorId: string;
    approvalState: "approved" | "not_required";
    executionState: "running" | "queued" | "not_started";
  }): void;
};

export type YouPetActionRequestCursorStoreRuntimeState = {
  openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<T>;
};

export function openYouPetActionRequestCursorStore(
  runtimeState: YouPetActionRequestCursorStoreRuntimeState,
): YouPetActionRequestCursorStore {
  return createYouPetActionRequestCursorStore(
    runtimeState.openSyncKeyedStore<YouPetActionRequestCursorRecord>({
      namespace: YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE,
      maxEntries: YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES,
    }),
  );
}

export function createYouPetActionRequestCursorStore(
  store: PluginStateSyncKeyedStore<YouPetActionRequestCursorRecord>,
): YouPetActionRequestCursorStore {
  return {
    load(params) {
      return store.lookup(toYouPetActionRequestCursorKey(params))?.next_cursor;
    },
    save(params) {
      store.register(toYouPetActionRequestCursorKey(params), {
        next_cursor: params.nextCursor,
      });
    },
    clear(params) {
      store.delete(toYouPetActionRequestCursorKey(params));
    },
  };
}

export function toYouPetActionRequestCursorKey(params: {
  tenantId: string;
  actorId: string;
  approvalState: "approved" | "not_required";
  executionState: "running" | "queued" | "not_started";
}): string {
  return [
    "action-request-cursor",
    params.tenantId,
    params.actorId,
    params.approvalState,
    params.executionState,
  ].join(".");
}
