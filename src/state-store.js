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
import { isDeepStrictEqual } from "node:util";
import { AgentDockError } from "./errors.js";
import {
  redactArgv,
  redactEnv,
  redactString,
  sensitiveValuesFromEnv,
} from "./redaction.js";
import {
  DEFAULT_PERSISTED_PROCESS_OUTPUT_BYTES,
  DEFAULT_STATE_RELATIVE_PATH,
} from "./config.js";

const SQLITE_SCHEMA_VERSION = 2;
const DOCUMENT_PART_PATTERN = /^[A-Za-z0-9._-]+$/;
export const LEGACY_IMPORT_MARKER_ID = "legacy_import_v1";

function legacyDocumentId(entry, { kind, directory }) {
  if (!entry.name.endsWith(".json")) return null;
  if (!entry.isFile()) {
    throw new AgentDockError(
      "INVALID_LEGACY_STATE_ENTRY",
      "Legacy state JSON entries must be regular files.",
      { kind, directory, filename: entry.name },
    );
  }

  const id = entry.name.slice(0, -".json".length);
  if (!DOCUMENT_PART_PATTERN.test(id)) {
    throw new AgentDockError(
      "INVALID_LEGACY_STATE_FILENAME",
      "Legacy state JSON filename contains an unsupported document id.",
      { kind, directory, filename: entry.name },
    );
  }
  return id;
}

function persistedOutput(record, maxPersistedOutputBytes, sensitiveValues) {
  const chunks = record.output ?? [];
  let bytes = 0;
  let truncated =
    Boolean(record.live_output_truncated) ||
    (record.output_floor_cursor ?? 0) > 0;
  const kept = [];

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    const text = redactString(String(chunk.text ?? ""), sensitiveValues);
    const size = Buffer.byteLength(text, "utf8");

    if (bytes + size <= maxPersistedOutputBytes) {
      kept.push({
        cursor: chunk.cursor,
        stream: chunk.stream,
        text,
        partial: Boolean(chunk.partial),
      });
      bytes += size;
      continue;
    }

    truncated = true;
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
        partial: true,
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
    persisted_output_truncated: truncated,
    output_total_bytes: record.output_total_bytes ?? bytes,
  };
}

function durableProcessSnapshot(record, maxPersistedOutputBytes) {
  const sensitiveValues = sensitiveValuesFromEnv(record.env);
  const outputState = persistedOutput(
    record,
    maxPersistedOutputBytes,
    sensitiveValues,
  );

  return {
    process_id: record.process_id,
    task_id: record.task_id,
    pid: record.pid,
    status: record.status,
    mode: record.mode,
    argv: redactArgv(record.argv, sensitiveValues),
    shell:
      record.shell == null
        ? record.shell
        : redactString(record.shell, sensitiveValues),
    cwd: redactString(record.cwd ?? "", sensitiveValues),
    env: redactEnv(record.env),
    started_at: record.started_at,
    ended_at: record.ended_at,
    exit_code: record.exit_code,
    signal: record.signal,
    error:
      record.error == null
        ? record.error
        : redactString(record.error, sensitiveValues),
    cancel_requested: record.cancel_requested,
    owner_instance_id: record.owner_instance_id,
    owner_pid: record.owner_pid,
    idempotency_operation_id: record.idempotency_operation_id,
    ...outputState,
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
    importLegacy = undefined,
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
      const importComplete = this.loadDocument("system", LEGACY_IMPORT_MARKER_ID);
      if (importLegacy ?? importComplete?.verified !== true) {
        this.importLegacyJson();
      }
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
      this.#migrateSqlite(version);
    }
    chmodSync(this.#dbPath, 0o600);
  }

  #migrateSqlite(fromVersion) {
    if (fromVersion >= 2) return;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db
        .prepare(
          "SELECT id, value_json FROM state_documents WHERE kind = 'process'",
        )
        .all();
      const update = this.#db.prepare(
        [
          "UPDATE state_documents",
          "SET value_json = ?, revision = revision + 1, updated_at = ?",
          "WHERE kind = 'process' AND id = ?",
        ].join("\n"),
      );

      for (const row of rows) {
        const record = JSON.parse(row.value_json);
        record.process_id ??= row.id;
        const sanitized = durableProcessSnapshot(
          record,
          this.#maxPersistedOutputBytes,
        );
        update.run(
          JSON.stringify(sanitized),
          new Date().toISOString(),
          row.id,
        );
      }

      this.#db.exec("PRAGMA user_version=2");
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error.
      }
      throw error;
    }
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
      const id = legacyDocumentId(entry, { kind, directory });
      if (id === null) continue;
      const filePath = path.join(directory, entry.name);
      const value = this.#readJson(filePath);
      if (value === null) continue;
      const importedValue =
        kind === "process"
          ? durableProcessSnapshot(
              {
                ...value,
                process_id: value.process_id ?? id,
              },
              this.#maxPersistedOutputBytes,
            )
          : value;
      const result = insert.run(
        kind,
        id,
        JSON.stringify(importedValue),
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
      imported += this.#importDirectory(
        "plan",
        path.join(this.#documentsDir, "plan"),
      );
      imported += this.#importDirectory(
        "operation",
        path.join(this.#documentsDir, "operation"),
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

  markLegacyImportComplete(details = {}) {
    this.#assertOpen();
    if (this.#backend !== "sqlite") {
      throw new AgentDockError(
        "SQLITE_STATE_REQUIRED",
        "Legacy import completion markers require SQLite.",
      );
    }
    const now = new Date().toISOString();
    return this.saveDocument("system", LEGACY_IMPORT_MARKER_ID, {
      ...cloneJson(details),
      completed: true,
      verified: true,
      completed_at: now,
    });
  }

  legacyImportReport() {
    this.#assertOpen();
    if (this.#backend !== "sqlite") {
      throw new AgentDockError(
        "SQLITE_STATE_REQUIRED",
        "Legacy import reporting requires the SQLite state backend.",
      );
    }

    const sources = [
      ["task", this.#tasksDir],
      ["process", this.#processesDir],
      ["audit", this.#auditsDir],
      ["workflow", this.#workflowsDir],
      ["plan", path.join(this.#documentsDir, "plan")],
      ["operation", path.join(this.#documentsDir, "operation")],
    ];
    const kinds = {};
    let legacyTotal = 0;
    let sqliteTotal = 0;
    let missingTotal = 0;
    let divergentTotal = 0;

    for (const [kind, directory] of sources) {
      let entries = [];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      const sqliteDocuments = new Map(
        this.listDocuments(kind).map((document) => [document.id, document.value]),
      );
      const legacyIds = [];
      const missingIds = [];
      const divergentIds = [];

      for (const entry of entries) {
        const id = legacyDocumentId(entry, { kind, directory });
        if (id === null) continue;
        const legacyValue = this.#readJson(path.join(directory, entry.name));
        if (legacyValue === null) continue;
        legacyIds.push(id);

        if (!sqliteDocuments.has(id)) {
          missingIds.push(id);
          continue;
        }

        const expected = kind === "process"
          ? durableProcessSnapshot(
              { ...legacyValue, process_id: legacyValue.process_id ?? id },
              this.#maxPersistedOutputBytes,
            )
          : legacyValue;
        const normalizedExpected = JSON.parse(JSON.stringify(expected));
        if (!isDeepStrictEqual(sqliteDocuments.get(id), normalizedExpected)) {
          divergentIds.push(id);
        }
      }

      legacyIds.sort();
      missingIds.sort();
      divergentIds.sort();
      const sqliteIds = [...sqliteDocuments.keys()].sort();
      kinds[kind] = {
        legacy_count: legacyIds.length,
        sqlite_count: sqliteIds.length,
        imported_identity_count: legacyIds.length - missingIds.length,
        missing_in_sqlite: missingIds,
        divergent_from_legacy: divergentIds,
        sqlite_only_count: sqliteIds.filter((id) => !legacyIds.includes(id)).length,
      };
      legacyTotal += legacyIds.length;
      sqliteTotal += sqliteIds.length;
      missingTotal += missingIds.length;
      divergentTotal += divergentIds.length;
    }

    const version = Number(
      this.#db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
    );
    const integrity = this.integrityCheck();
    return {
      backend: this.#backend,
      database_path: this.#dbPath,
      schema_version: version,
      integrity_check: integrity,
      identity_complete: missingTotal === 0,
      content_matches_legacy: divergentTotal === 0,
      legacy_document_count: legacyTotal,
      sqlite_document_count: sqliteTotal,
      missing_document_count: missingTotal,
      divergent_document_count: divergentTotal,
      kinds,
    };
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

  listProcessMetadata() {
    this.#assertOpen();
    if (this.#backend === "sqlite") {
      return this.#db
        .prepare(
          [
            "SELECT",
            "  id,",
            "  json_extract(value_json, '$.task_id') AS task_id,",
            "  json_extract(value_json, '$.status') AS status,",
            "  json_extract(value_json, '$.started_at') AS started_at,",
            "  json_extract(value_json, '$.ended_at') AS ended_at",
            "FROM state_documents",
            "WHERE kind = 'process'",
            "ORDER BY id",
          ].join("\n"),
        )
        .all()
        .map((row) => ({
          process_id: row.id,
          task_id: row.task_id,
          status: row.status,
          started_at: row.started_at,
          ended_at: row.ended_at,
        }));
    }

    return this.listDocuments("process").map((document) => ({
      process_id: document.id,
      task_id: document.value?.task_id ?? null,
      status: document.value?.status ?? null,
      started_at: document.value?.started_at ?? null,
      ended_at: document.value?.ended_at ?? null,
    }));
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
    const serializable = durableProcessSnapshot(
      record,
      this.#maxPersistedOutputBytes,
    );

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
