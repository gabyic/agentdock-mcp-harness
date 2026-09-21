import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AgentDockError } from "./errors.js";
import { resolveExistingTaskPath } from "./workspace-paths.js";

export class ProcessService {
  #tasks;
  #store;
  #approval;
  #processes = new Map();

  constructor({ taskService, stateStore, approvalService }) {
    this.#tasks = taskService;
    this.#store = stateStore;
    this.#approval = approvalService;
  }

  #restore(processId) {
    const snapshot = this.#store.loadProcess(processId);
    if (!snapshot) {
      return null;
    }

    const record = {
      ...snapshot,
      output: snapshot.output ?? [],
      child: null,
    };

    if (record.status === "RUNNING" || record.status === "CANCELLING") {
      record.status = "INTERRUPTED";
      record.ended_at ??= new Date().toISOString();
      record.error ??=
        "AgentDock restarted or lost ownership of the running process.";
      this.#store.saveProcess(record);
    }

    this.#processes.set(processId, record);
    return record;
  }

  #get(processId) {
    if (!/^proc_[0-9a-f-]{36}$/.test(processId)) {
      throw new AgentDockError("INVALID_PROCESS_ID", "Invalid process_id format.");
    }

    const record = this.#processes.get(processId) ?? this.#restore(processId);
    if (!record) {
      throw new AgentDockError(
        "PROCESS_NOT_FOUND",
        "Process not found: " + processId,
      );
    }
    return record;
  }

  #public(record) {
    return {
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
    };
  }

  summariesForTask(taskId) {
    const task = this.#tasks.get(taskId);
    return (task.process_ids ?? []).map((processId) => {
      const record = this.#get(processId);
      if (record.task_id !== taskId) {
        throw new AgentDockError(
          "PROCESS_TASK_MISMATCH",
          "Persisted process does not belong to this Task.",
        );
      }
      return this.#public(record);
    });
  }

  activeForTask(taskId) {
    return this.summariesForTask(taskId).filter(
      (record) =>
        record.status === "RUNNING" || record.status === "CANCELLING",
    );
  }

  cancelAllForTask(taskId) {
    const task = this.#tasks.get(taskId);
    const results = [];
    for (const processId of task.process_ids ?? []) {
      const record = this.#get(processId);
      if (
        record.status === "RUNNING" ||
        record.status === "CANCELLING"
      ) {
        results.push(this.cancel({ taskId, processId }));
      }
    }
    return results;
  }

  async start({
    taskId,
    argv,
    shell,
    cwd = ".",
    env = {},
  }) {
    this.#tasks.assertActive(taskId);

    const hasArgv = Array.isArray(argv);
    const hasShell = typeof shell === "string";

    if (hasArgv === hasShell) {
      throw new AgentDockError(
        "INVALID_PROCESS_MODE",
        "Provide exactly one of argv or shell.",
      );
    }
    if (hasArgv && argv.length === 0) {
      throw new AgentDockError(
        "INVALID_PROCESS_MODE",
        "argv must contain at least one element.",
      );
    }
    if (hasShell && shell.length === 0) {
      throw new AgentDockError(
        "INVALID_PROCESS_MODE",
        "shell must not be empty.",
      );
    }

    const { resolved } = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      cwd,
    );

    this.#approval?.authorize({
      taskId,
      tool: "process.start",
      shell,
      argv,
      cwd: resolved,
      env,
    });

    const processId = "proc_" + randomUUID();
    const mode = hasArgv ? "argv" : "shell";
    const command = hasArgv ? argv[0] : shell;
    const args = hasArgv ? argv.slice(1) : [];
    const child = spawn(command, args, {
      cwd: resolved,
      env: { ...process.env, ...env },
      shell: hasShell,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const record = {
      process_id: processId,
      task_id: taskId,
      pid: child.pid ?? null,
      status: "RUNNING",
      mode,
      argv: hasArgv ? [...argv] : undefined,
      shell: hasShell ? shell : undefined,
      cwd: resolved,
      env: { ...env },
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      signal: null,
      error: null,
      cancel_requested: false,
      output: [],
      child,
    };
    this.#processes.set(processId, record);
    this.#store.saveProcess(record);
    this.#tasks.addProcess(taskId, processId);

    const append = (stream, chunk) => {
      record.output.push({
        stream,
        text: chunk.toString("utf8"),
      });
      this.#store.saveProcess(record);
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error) => {
      record.status = "FAILED";
      record.error = error.message;
      record.ended_at = new Date().toISOString();
      record.child = null;
      this.#store.saveProcess(record);
    });

    child.on("close", (code, signal) => {
      if (record.cancel_requested) {
        record.status = "CANCELLED";
      } else if (record.status !== "FAILED") {
        record.status = "EXITED";
      }
      record.exit_code = code;
      record.signal = signal;
      record.ended_at ??= new Date().toISOString();
      record.child = null;
      this.#store.saveProcess(record);
    });

    return this.#public(record);
  }

  status({ taskId, processId }) {
    const record = this.#get(processId);
    if (record.task_id !== taskId) {
      throw new AgentDockError(
        "PROCESS_TASK_MISMATCH",
        "Process does not belong to this Task.",
      );
    }
    return this.#public(record);
  }

  output({ taskId, processId, cursor = 0 }) {
    const record = this.#get(processId);
    if (record.task_id !== taskId) {
      throw new AgentDockError(
        "PROCESS_TASK_MISMATCH",
        "Process does not belong to this Task.",
      );
    }
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > record.output.length) {
      throw new AgentDockError(
        "INVALID_OUTPUT_CURSOR",
        "Cursor is outside the available process output range.",
      );
    }

    const chunks = record.output.slice(cursor);
    return {
      process_id: processId,
      task_id: taskId,
      status: record.status,
      cursor,
      next_cursor: record.output.length,
      chunks,
      stdout_chunk: chunks
        .filter((chunk) => chunk.stream === "stdout")
        .map((chunk) => chunk.text)
        .join(""),
      stderr_chunk: chunks
        .filter((chunk) => chunk.stream === "stderr")
        .map((chunk) => chunk.text)
        .join(""),
      exit_code: record.exit_code,
      signal: record.signal,
    };
  }

  cancel({ taskId, processId }) {
    const record = this.#get(processId);
    if (record.task_id !== taskId) {
      throw new AgentDockError(
        "PROCESS_TASK_MISMATCH",
        "Process does not belong to this Task.",
      );
    }

    if (record.status !== "RUNNING") {
      return this.#public(record);
    }

    record.cancel_requested = true;
    record.status = "CANCELLING";
    this.#store.saveProcess(record);

    try {
      if (record.pid) {
        process.kill(-record.pid, "SIGTERM");
      } else {
        record.child?.kill("SIGTERM");
      }
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }

    return this.#public(record);
  }
}
