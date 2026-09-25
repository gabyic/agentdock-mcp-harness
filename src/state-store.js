import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { AgentDockError } from "./errors.js";
import { redactEnv } from "./redaction.js";
import {
  DEFAULT_PERSISTED_PROCESS_OUTPUT_BYTES,
  DEFAULT_STATE_RELATIVE_PATH,
} from "./config.js";

const SQLITE_SCHEMA_VERSION = 1;
const DOCUMENT_PART_PATTERN = /^[A-Za-z0-9._-]+$/;

function persistedOutput(record, maxPersistedOutputBytes) {
  const chunks = record.output ?? [];
  let bytes = 0;
  const kept = [];

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    const text = String(chunk.text ?? "");
    const size = Buffer.byteLength(text, "utf8");

    if (bytes + size <= maxPersistedOutputBytes) {
      kept.push({
        cursor: chunk.cursor,
        stream: chunk.stream,
        text,
      });
      bytes += size;
      continue;
    }

    const remaining = maxPersistedOutputBytes - bytes;
    if (remaining > 0) {
      const buffer = Buffer.from(text, "utf8");
      const tail = buffer
        .subarray(Math.max(0, buffer.length - remaining))
        .toString("utf8");
      kept.push({
        cursor: chunk.cursor,
        stream: chunk.stream,
        text: tail,
      });
      bytes += Buffer.byteLength(tail, "utf8");
    }
    break;
  }

  kept.reverse();
  const floorCursor =
    kept.length > 0
      ? kept[0].cursor
      : record.next_output_cursor ?? 0;

  return {
    output: kept,
    output_floor_cursor: floorCursor,
    next_output_cursor: record.next_output_cursor ?? chunks.length,
    persisted_output_bytes: bytes,
    persisted_output_truncated:
      floorCursor > 0 || bytes < (record.output_total_bytes ?? bytes),
    output_total_bytes: record.output_total_bytes ?? bytes,
  };
}

function safeDocumentPart(value, field) {
  const normalized = String(value ?? "").trim();
  if (!DOCUMENT_PART_PATTERN.test(normalized)) {
    throw new AgentDockError(
      "INVALID_STATE_DOCUMENT_KEY",
      field + " contains unsupported characters.",
      { [field]: normalized },
    );
  }
  return normalized;
}

function cloneJson(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}

export class StateStore {
  #stateDir;
  #tasksDir;
  #processesDir;
  #auditsDir;
  #runtimeLeasesDir;
  #workflowsDir;
  #documentsDir;
  #maxPersistedOutputBytes;
  #backend;
  #db = null;
  #dbPath = null;
  #closed = false;

  constructor({
    stateDir = path.join(os.homedir(), DEFAULT_STATE_RELATIVE_PATH),
    backend = "sqlite",
    maxPersistedOutputBytes = DEFAULT_PERSISTED_PROCESS_OUTPUT_BYTES,
  } = {}) {
    if (
      !Number.isInteger(maxPersistedOutputBytes) ||
      maxPersistedOutputBytes < 1024
    ) {
      throw new TypeError(
        "maxPersistedOutputBytes must be an integer >= 1024.",
      );
    }
    if (!["json", "sqlite"].includes(backend)) {
      throw new AgentDockError(
        "INVALID_STATE_BACKEND",
        "State backend must be json or sqlite.",
        { backend },
      );
    }

    this.#stateDir = stateDir;
    this.#backend = backend;
    this.#maxPersistedOutputBytes = maxPersistedOutputBytes;
    this.#tasksDir = path.join(this.#stateDir, "tasks");
    this.#processesDir = path.join(this.#stateDir, "processes");
    this.#auditsDir = path.join(this.#stateDir, "audits");
    this.#runtimeLeasesDir = path.join(this.#stateDir, "runtime-leases");
    this.#workflowsDir = path.join(this.#stateDir, "workflows");
    this.#documentsDir = path.join(this.#stateDir, "documents");

    mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#stateDir, 0o700);
    mkdirSync(this.#tasksDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#processesDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#auditsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#runtimeLeasesDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#workflowsDir, { recursive: true, mode: 0o700 });

    if (this.#backend === "sqlite") {
      this.#openSqlite();
      this.importLegacyJson();
    }
  }

  get stateDir() {
    return this.#stateDir;
  }

  get backend() {
    return this.#backend;
  }

  get maxPersistedOutputBytes() {
    return this.#maxPersistedOutputBytes;
  }

  get databasePath() {
    return this.#dbPath;
  }

  #assertOpen() {
    if (this.#closed) {
      throw new AgentDockError(
        "STATE_STORE_CLOSED",
        "StateStore is already closed.",
      );
    }
  }

  #openSqlite() {
    this.#dbPath = path.join(this.#stateDir, "agentdock.db");
    this.#db = new DatabaseSync(this.#dbPath, { timeout: 5000 });
    this.#db.exec("PRAGMA busy_timeout=5000");
    this.#db.exec("PRAGMA foreign_keys=ON");
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=NORMAL");
    this.#db.exec(
      [
        "CREATE TABLE IF NOT EXISTS state_documents (",
        "  kind TEXT NOT NULL,",
        "  id TEXT NOT NULL,",
        "  value_json TEXT NOT NULL,",
        "  revision INTEGER NOT NULL DEFAULT 1,",
        "  updated_at TEXT NOT NULL,",
        "  PRIMARY KEY (kind, id)",
        ")",
      ].join("\n"),
    );

    const row = this.#db.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version ?? 0);
    if (version > SQLITE_SCHEMA_VERSION) {
      this.#db.close();
      this.#db = null;
      throw new AgentDockError(
        "STATE_SCHEMA_TOO_NEW",
        "AgentDock state database was created by a newer schema version.",
        {
          database_version: version,
          supported_version: SQLITE_SCHEMA_VERSION,
        },
      );
    }
    if (version < SQLITE_SCHEMA_VERSION) {
      this.#db.exec("PRAGMA user_version=" + SQLITE_SCHEMA_VERSION);
    }
    chmodSync(this.#dbPath, 0o600);
  }

  #readJson(filePath) {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  #writeJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath =
      filePath +
      ".tmp-" +
      process.pid +
      "-" +
      Date.now() +
      "-" +
      Math.random().toString(16).slice(2);

    writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  }

  #documentPath(kind, id) {
    const safeKind = safeDocumentPart(kind, "kind");
    const safeId = safeDocumentPart(id, "id");
    return path.join(this.#documentsDir, safeKind, safeId + ".json");
  }

  loadDocument(kind, id) {
    this.#assertOpen();
    const safeKind = safeDocumentPart(kind, "kind");
    const safeId = safeDocumentPart(id, "id");

    if (this.#backend === "sqlite") {
      const row = this.#db
        .prepare(
          "SELECT value_json FROM state_documents WHERE kind = ? AND id = ?",
        )
        .get(safeKind, safeId);
      return row ? JSON.parse(row.value_json) : null;
    }

    return this.#readJson(this.#documentPath(safeKind, safeId));
  }

  saveDocument(kind, id, value) {
    this.#assertOpen();
    const safeKind = safeDocumentPart(kind, "kind");
    const safeId = safeDocumentPart(id, "id");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new AgentDockError(
        "INVALID_STATE_DOCUMENT",
        "State documents must be JSON-serializable.",
      );
    }

    if (this.#backend === "sqlite") {
      const now = new Date().toISOString();
      this.#db
        .prepare(
          [
            "INSERT INTO state_documents(kind, id, value_json, revision, updated_at)",
            "VALUES (?, ?, ?, 1, ?)",
            "ON CONFLICT(kind, id) DO UPDATE SET",
            "  value_json = excluded.value_json,",
            "  revision = state_documents.revision + 1,",
            "  updated_at = excluded.updated_at",
          ].join("\n"),
        )
        .run(safeKind, safeId, serialized, now);
      return value;
    }

    this.#writeJson(this.#documentPath(safeKind, safeId), value);
    return value;
  }

  deleteDocument(kind, id) {
    this.#assertOpen();
    const safeKind = safeDocumentPart(kind, "kind");
    const safeId = safeDocumentPart(id, "id");

    if (this.#backend === "sqlite") {
      this.#db
        .prepare("DELETE FROM state_documents WHERE kind = ? AND id = ?")
        .run(safeKind, safeId);
      return;
    }

    try {
      unlinkSync(this.#documentPath(safeKind, safeId));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  mutateDocument(
    kind,
    id,
    mutator,
    { defaultValue = null } = {},
  ) {
    this.#assertOpen();
    if (typeof mutator !== "function") {
      throw new TypeError("mutator must be a function.");
    }

    const safeKind = safeDocumentPart(kind, "kind");
    const safeId = safeDocumentPart(id, "id");

    if (this.#backend !== "sqlite") {
      const current =
        this.loadDocument(safeKind, safeId) ?? cloneJson(defaultValue);
      const next = mutator(cloneJson(current));
      if (next === undefined) {
        throw new AgentDockError(
          "INVALID_STATE_MUTATION",
          "State mutation must return a JSON value.",
        );
      }
      this.saveDocument(safeKind, safeId, next);
      return next;
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare(
          [
            "SELECT value_json FROM state_documents",
            "WHERE kind = ? AND id = ?",
          ].join("\n"),
        )
        .get(safeKind, safeId);
      const current = row
        ? JSON.parse(row.value_json)
        : cloneJson(defaultValue);
      const next = mutator(cloneJson(current));
      const serialized = JSON.stringify(next);
      if (serialized === undefined) {
        throw new AgentDockError(
          "INVALID_STATE_MUTATION",
          "State mutation must return a JSON value.",
        );
      }
      const now = new Date().toISOString();
      this.#db
        .prepare(
          [
            "INSERT INTO state_documents(kind, id, value_json, revision, updated_at)",
            "VALUES (?, ?, ?, 1, ?)",
            "ON CONFLICT(kind, id) DO UPDATE SET",
            "  value_json = excluded.value_json,",
            "  revision = state_documents.revision + 1,",
            "  updated_at = excluded.updated_at",
          ].join("\n"),
        )
        .run(safeKind, safeId, serialized, now);
      this.#db.exec("COMMIT");
      return next;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original mutation error.
      }
      throw error;
    }
  }

  #importDirectory(kind, directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }

    const insert = this.#db.prepare(
      [
        "INSERT OR IGNORE INTO state_documents",
        "(kind, id, value_json, revision, updated_at)",
        "VALUES (?, ?, ?, 1, ?)",
      ].join("\n"),
    );
    let imported = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!DOCUMENT_PART_PATTERN.test(id)) continue;
      const filePath = path.join(directory, entry.name);
      const value = this.#readJson(filePath);
      if (value === null) continue;
      const result = insert.run(
        kind,
        id,
        JSON.stringify(value),
        new Date().toISOString(),
      );
      if (Number(result.changes ?? 0) > 0) imported += 1;
    }
    return imported;
  }

  importLegacyJson() {
    this.#assertOpen();
    if (this.#backend !== "sqlite") {
      return { imported: 0, backend: this.#backend };
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      let imported = 0;
      imported += this.#importDirectory("task", this.#tasksDir);
      imported += this.#importDirectory("process", this.#processesDir);
      imported += this.#importDirectory("audit", this.#auditsDir);
      imported += this.#importDirectory(
        "workflow",
        path.join(this.#stateDir, "workflows"),
      );
      this.#db.exec("COMMIT");
      return { imported, backend: this.#backend };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original import error.
      }
      throw error;
    }
  }

  integrityCheck() {
    this.#assertOpen();
    if (this.#backend !== "sqlite") return null;
    const row = this.#db.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check ?? null;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }

  runtimeLeasePath(instanceId) {
    if (!/^runtime_[0-9a-f-]{36}$/.test(instanceId)) {
      throw new TypeError("Invalid runtime instance id.");
    }
    return path.join(this.#runtimeLeasesDir, instanceId + ".json");
  }

  loadRuntimeLease(instanceId) {
    return this.#readJson(this.runtimeLeasePath(instanceId));
  }

  saveRuntimeLease(lease) {
    this.#writeJson(this.runtimeLeasePath(lease.instance_id), lease);
  }

  deleteRuntimeLease(instanceId) {
    try {
      unlinkSync(this.runtimeLeasePath(instanceId));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  listDocuments(kind) {
    this.#assertOpen();
    const safeKind = safeDocumentPart(kind, "kind");
    if (this.#backend === "sqlite") {
      return this.#db
        .prepare(
          "SELECT id, value_json FROM state_documents WHERE kind = ? ORDER BY id",
        )
        .all(safeKind)
        .map((row) => ({
          id: row.id,
          value: JSON.parse(row.value_json),
        }));
    }

    const directory =
      safeKind === "task"
        ? this.#tasksDir
        : safeKind === "process"
          ? this.#processesDir
          : safeKind === "audit"
            ? this.#auditsDir
            : safeKind === "workflow"
              ? this.#workflowsDir
              : path.join(this.#documentsDir, safeKind);

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const id = entry.name.slice(0, -".json".length);
        return {
          id,
          value: this.#readJson(path.join(directory, entry.name)),
        };
      })
      .filter((entry) => entry.value !== null);
  }

  taskPath(taskId) {
    return path.join(this.#tasksDir, taskId + ".json");
  }

  processPath(processId) {
    return path.join(this.#processesDir, processId + ".json");
  }

  auditPath(taskId) {
    return path.join(this.#auditsDir, taskId + ".json");
  }

  loadTask(taskId) {
    if (this.#backend === "sqlite") {
      return this.loadDocument("task", taskId);
    }
    return this.#readJson(this.taskPath(taskId));
  }

  mutateTask(taskId, mutator) {
    if (this.#backend === "sqlite") {
      return this.mutateDocument("task", taskId, mutator, {
        defaultValue: null,
      });
    }
    const current = this.loadTask(taskId);
    const next = mutator(cloneJson(current));
    if (next === undefined) {
      throw new AgentDockError(
        "INVALID_STATE_MUTATION",
        "Task mutation must return a JSON value.",
      );
    }
    this.saveTask(next);
    return next;
  }

  saveTask(task) {
    if (this.#backend === "sqlite") {
      return this.saveDocument("task", task.task_id, task);
    }
    this.#writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  loadProcess(processId) {
    if (this.#backend === "sqlite") {
      return this.loadDocument("process", processId);
    }
    return this.#readJson(this.processPath(processId));
  }

  saveProcess(record) {
    const outputState = persistedOutput(
      record,
      this.#maxPersistedOutputBytes,
    );
    const serializable = {
      process_id: record.process_id,
      task_id: record.task_id,
      pid: record.pid,
      status: record.status,
      mode: record.mode,
      argv: record.argv,
      shell: record.shell,
      cwd: record.cwd,
      env: redactEnv(record.env),
      started_at: record.started_at,
      ended_at: record.ended_at,
      exit_code: record.exit_code,
      signal: record.signal,
      error: record.error,
      cancel_requested: record.cancel_requested,
      owner_instance_id: record.owner_instance_id,
      owner_pid: record.owner_pid,
      idempotency_operation_id: record.idempotency_operation_id,
      ...outputState,
    };

    if (this.#backend === "sqlite") {
      this.saveDocument("process", record.process_id, serializable);
    } else {
      this.#writeJson(this.processPath(record.process_id), serializable);
    }
    return serializable;
  }

  loadAudit(taskId) {
    const loaded =
      this.#backend === "sqlite"
        ? this.loadDocument("audit", taskId)
        : this.#readJson(this.auditPath(taskId));
    return loaded ?? {
      task_id: taskId,
      next_sequence: 1,
      entries: [],
    };
  }

  mutateAudit(taskId, mutator) {
    const initial = {
      task_id: taskId,
      next_sequence: 1,
      entries: [],
    };
    if (this.#backend === "sqlite") {
      return this.mutateDocument("audit", taskId, mutator, {
        defaultValue: initial,
      });
    }
    const current = this.loadAudit(taskId);
    const next = mutator(cloneJson(current));
    if (next === undefined) {
      throw new AgentDockError(
        "INVALID_STATE_MUTATION",
        "Audit mutation must return a JSON value.",
      );
    }
    this.saveAudit(taskId, next);
    return next;
  }

  saveAudit(taskId, value) {
    if (this.#backend === "sqlite") {
      return this.saveDocument("audit", taskId, value);
    }
    this.#writeJson(this.auditPath(taskId), value);
    return value;
  }

  workflowPath(workflowId) {
    return path.join(this.#workflowsDir, workflowId + ".json");
  }

  loadWorkflow(workflowId) {
    if (this.#backend === "sqlite") {
      return this.loadDocument("workflow", workflowId);
    }
    return this.#readJson(this.workflowPath(workflowId));
  }

  saveWorkflow(workflowId, workflow) {
    if (this.#backend === "sqlite") {
      return this.saveDocument("workflow", workflowId, workflow);
    }
    this.#writeJson(this.workflowPath(workflowId), workflow);
    return workflow;
  }

  mutateWorkflow(workflowId, mutator) {
    if (this.#backend === "sqlite") {
      return this.mutateDocument("workflow", workflowId, mutator, {
        defaultValue: null,
      });
    }
    const current = this.loadWorkflow(workflowId);
    const next = mutator(cloneJson(current));
    if (next === undefined) {
      throw new AgentDockError(
        "INVALID_STATE_MUTATION",
        "Workflow mutation must return a JSON value.",
      );
    }
    this.saveWorkflow(workflowId, next);
    return next;
  }

  listWorkflows() {
    return this.listDocuments("workflow");
  }
}
