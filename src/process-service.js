import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AgentDockError } from "./errors.js";
import { resolveExistingTaskPath } from "./workspace-paths.js";

export class ProcessService {
  #tasks;
  #processes = new Map();

  constructor({ taskService }) {
    this.#tasks = taskService;
  }

  #get(processId) {
    const record = this.#processes.get(processId);
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

  async start({
    taskId,
    argv,
    shell,
    cwd = ".",
    env = {},
  }) {
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

    const append = (stream, chunk) => {
      record.output.push({
        stream,
        text: chunk.toString("utf8"),
      });
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error) => {
      record.status = "FAILED";
      record.error = error.message;
      record.ended_at = new Date().toISOString();
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
