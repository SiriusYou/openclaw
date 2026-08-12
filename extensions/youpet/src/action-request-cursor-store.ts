import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const YOUPET_ACTION_REQUEST_CURSOR_STORE_NAMESPACE = "action-request-cursors";
// One configured tenant/actor owns six dispatcher slice keys. The fixed bound
// leaves room for a few retired identities without making this a multi-tenant store.
export const YOUPET_ACTION_REQUEST_CURSOR_STORE_MAX_ENTRIES = 32;

export type YouPetActionRequestCursorRecord = {
  next_cursor: string;
};

export class YouPetActionRequestCursorStoreError extends Error {
  override readonly cause: unknown;
  readonly operation: "load" | "save" | "clear";
  readonly sliceKey: string;

  constructor(params: { cause: unknown; operation: "load" | "save" | "clear"; sliceKey: string }) {
    super(`YouPet ActionRequest cursor ${params.operation} failed for ${params.sliceKey}`);
    this.name = "YouPetActionRequestCursorStoreError";
    this.cause = params.cause;
    this.operation = params.operation;
    this.sliceKey = params.sliceKey;
  }
}

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
      const sliceKey = toYouPetActionRequestCursorKey(params);
      try {
        return store.lookup(sliceKey)?.next_cursor;
      } catch (error) {
        throw wrapCursorStoreError(error, "load", sliceKey);
      }
    },
    save(params) {
      const sliceKey = toYouPetActionRequestCursorKey(params);
      try {
        store.register(sliceKey, {
          next_cursor: params.nextCursor,
        });
      } catch (error) {
        throw wrapCursorStoreError(error, "save", sliceKey);
      }
    },
    clear(params) {
      const sliceKey = toYouPetActionRequestCursorKey(params);
      try {
        store.delete(sliceKey);
      } catch (error) {
        throw wrapCursorStoreError(error, "clear", sliceKey);
      }
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

function wrapCursorStoreError(
  error: unknown,
  operation: "load" | "save" | "clear",
  sliceKey: string,
): YouPetActionRequestCursorStoreError {
  if (error instanceof YouPetActionRequestCursorStoreError) {
    return error;
  }
  return new YouPetActionRequestCursorStoreError({
    cause: error,
    operation,
    sliceKey,
  });
}
