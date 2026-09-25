import { createHash } from "node:crypto";
import { AgentDockError } from "./errors.js";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 5000;
const TERMINAL_STATUSES = new Set([
  "EXITED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestFingerprint(request) {
  return sha256(JSON.stringify(canonicalize(request)));
}

function normalizeKey(key) {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new AgentDockError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotency_key must be a non-empty string.",
    );
  }
  if (key.length > 256) {
    throw new AgentDockError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotency_key must be at most 256 characters.",
    );
  }
  return key;
}

function operationId({ taskId, tool, key }) {
  return "op_" + sha256(taskId + "\0" + tool + "\0" + key);
}

function assertCompatible(operation, { taskId, tool, fingerprint }) {
  if (
    operation.task_id !== taskId ||
    operation.tool !== tool ||
    operation.request_fingerprint !== fingerprint
  ) {
    throw new AgentDockError(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different request.",
      {
        operation_id: operation.operation_id,
        run_id: operation.run_id ?? null,
      },
    );
  }
}

export class IdempotencyService {
  #store;
  #retentionMs;
  #maxRecords;

  constructor({
    stateStore,
    retentionMs = DEFAULT_RETENTION_MS,
    maxRecords = DEFAULT_MAX_RECORDS,
  }) {
    this.#store = stateStore;
    this.#retentionMs = retentionMs;
    this.#maxRecords = maxRecords;
  }

  #identity({ taskId, tool, key, request }) {
    const normalizedKey = normalizeKey(key);
    return {
      operationId: operationId({
        taskId,
        tool,
        key: normalizedKey,
      }),
      fingerprint: requestFingerprint(request),
    };
  }

  lookup({ taskId, tool, key, request }) {
    const identity = this.#identity({ taskId, tool, key, request });
    const operation = this.#store.loadDocument(
      "operation",
      identity.operationId,
    );
    if (operation) {
      assertCompatible(operation, {
        taskId,
        tool,
        fingerprint: identity.fingerprint,
      });
    }
    return {
      ...identity,
      operation,
    };
  }

  claim({
    taskId,
    tool,
    key,
    request,
    runId,
    ownerInstanceId,
  }) {
    this.prune();
    const identity = this.#identity({ taskId, tool, key, request });
    let created = false;
    const now = new Date().toISOString();
    const operation = this.#store.mutateDocument(
      "operation",
      identity.operationId,
      (current) => {
        if (current) {
          assertCompatible(current, {
            taskId,
            tool,
            fingerprint: identity.fingerprint,
          });
          return current;
        }

        created = true;
        return {
          operation_id: identity.operationId,
          task_id: taskId,
          tool,
          request_fingerprint: identity.fingerprint,
          run_id: runId,
          status: "CLAIMED",
          owner_instance_id: ownerInstanceId,
          created_at: now,
          updated_at: now,
          completed_at: null,
        };
      },
      { defaultValue: null },
    );

    return {
      ...identity,
      operation,
      created,
    };
  }

  takeover({ operationId, runId, ownerInstanceId }) {
    return this.#store.mutateDocument(
      "operation",
      operationId,
      (current) => {
        if (!current || current.run_id !== runId) {
          throw new AgentDockError(
            "IDEMPOTENCY_OPERATION_NOT_FOUND",
            "Idempotency operation is missing or does not match the Run.",
            { operation_id: operationId, run_id: runId },
          );
        }
        if (TERMINAL_STATUSES.has(current.status)) {
          return current;
        }
        current.owner_instance_id = ownerInstanceId;
        current.updated_at = new Date().toISOString();
        return current;
      },
      { defaultValue: null },
    );
  }

  mark({ operationId, runId, status }) {
    if (!operationId) return null;
    return this.#store.mutateDocument(
      "operation",
      operationId,
      (current) => {
        if (!current || current.run_id !== runId) {
          return current;
        }
        const now = new Date().toISOString();
        current.status = status;
        current.updated_at = now;
        if (TERMINAL_STATUSES.has(status)) {
          current.completed_at ??= now;
        }
        return current;
      },
      { defaultValue: null },
    );
  }

  prune() {
    const now = Date.now();
    const documents = this.#store.listDocuments("operation");

    for (const document of documents) {
      const operation = document.value;
      if (!TERMINAL_STATUSES.has(operation?.status)) continue;
      const completedAt = Date.parse(
        operation.completed_at ?? operation.updated_at ?? operation.created_at,
      );
      if (
        Number.isFinite(completedAt) &&
        now - completedAt >= this.#retentionMs
      ) {
        this.#store.deleteDocument("operation", document.id);
        continue;
      }
    }

    let remaining = this.#store.listDocuments("operation");
    if (remaining.length < this.#maxRecords) {
      return { retained: remaining.length };
    }

    const terminal = remaining
      .filter((document) => TERMINAL_STATUSES.has(document.value?.status))
      .sort((left, right) => {
        const leftTime = Date.parse(
          left.value.completed_at ??
            left.value.updated_at ??
            left.value.created_at ??
            0,
        );
        const rightTime = Date.parse(
          right.value.completed_at ??
            right.value.updated_at ??
            right.value.created_at ??
            0,
        );
        return leftTime - rightTime;
      });

    for (const document of terminal) {
      if (remaining.length < this.#maxRecords) break;
      this.#store.deleteDocument("operation", document.id);
      remaining = remaining.filter((item) => item.id !== document.id);
    }

    if (remaining.length >= this.#maxRecords) {
      throw new AgentDockError(
        "IDEMPOTENCY_RETENTION_FULL",
        "Idempotency retention is full of non-terminal operations.",
        { max_records: this.#maxRecords },
      );
    }

    return { retained: remaining.length };
  }
}

export const IDEMPOTENCY_RETENTION = Object.freeze({
  retention_ms: DEFAULT_RETENTION_MS,
  max_records: DEFAULT_MAX_RECORDS,
});
