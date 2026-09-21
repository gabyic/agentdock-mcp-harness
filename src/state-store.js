import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactEnv } from "./redaction.js";

const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1024;

function persistedOutput(record) {
  const chunks = record.output ?? [];
  let bytes = 0;
  const kept = [];

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    const text = String(chunk.text ?? "");
    const size = Buffer.byteLength(text, "utf8");

    if (bytes + size <= MAX_PERSISTED_OUTPUT_BYTES) {
      kept.push({
        cursor: chunk.cursor,
        stream: chunk.stream,
        text,
      });
      bytes += size;
      continue;
    }

    const remaining = MAX_PERSISTED_OUTPUT_BYTES - bytes;
    if (remaining > 0) {
      const buffer = Buffer.from(text, "utf8");
      const tail = buffer.subarray(Math.max(0, buffer.length - remaining)).toString("utf8");
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

export class StateStore {
  #stateDir;
  #tasksDir;
  #processesDir;
  #auditsDir;

  constructor({ stateDir } = {}) {
    this.#stateDir =
      stateDir ??
      process.env.AGENTDOCK_STATE_DIR ??
      path.join(os.homedir(), ".local", "state", "agentdock");
    this.#tasksDir = path.join(this.#stateDir, "tasks");
    this.#processesDir = path.join(this.#stateDir, "processes");
    this.#auditsDir = path.join(this.#stateDir, "audits");

    mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#stateDir, 0o700);
    mkdirSync(this.#tasksDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#processesDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#auditsDir, { recursive: true, mode: 0o700 });
  }

  get stateDir() {
    return this.#stateDir;
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
    return this.#readJson(this.taskPath(taskId));
  }

  saveTask(task) {
    this.#writeJson(this.taskPath(task.task_id), task);
  }

  loadProcess(processId) {
    return this.#readJson(this.processPath(processId));
  }

  saveProcess(record) {
    const outputState = persistedOutput(record);
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
      ...outputState,
    };
    this.#writeJson(this.processPath(record.process_id), serializable);
  }

  loadAudit(taskId) {
    return this.#readJson(this.auditPath(taskId)) ?? {
      task_id: taskId,
      next_sequence: 1,
      entries: [],
    };
  }

  saveAudit(taskId, value) {
    this.#writeJson(this.auditPath(taskId), value);
  }
}
