import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export class StateStore {
  #stateDir;
  #tasksDir;
  #processesDir;

  constructor({ stateDir } = {}) {
    this.#stateDir =
      stateDir ??
      process.env.AGENTDOCK_STATE_DIR ??
      path.join(os.homedir(), ".local", "state", "agentdock");
    this.#tasksDir = path.join(this.#stateDir, "tasks");
    this.#processesDir = path.join(this.#stateDir, "processes");

    mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#stateDir, 0o700);
    mkdirSync(this.#tasksDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#processesDir, { recursive: true, mode: 0o700 });
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
    const serializable = {
      process_id: record.process_id,
      task_id: record.task_id,
      pid: record.pid,
      status: record.status,
      mode: record.mode,
      argv: record.argv,
      shell: record.shell,
      cwd: record.cwd,
      env: record.env,
      started_at: record.started_at,
      ended_at: record.ended_at,
      exit_code: record.exit_code,
      signal: record.signal,
      error: record.error,
      cancel_requested: record.cancel_requested,
      output: record.output ?? [],
    };
    this.#writeJson(this.processPath(record.process_id), serializable);
  }
}
