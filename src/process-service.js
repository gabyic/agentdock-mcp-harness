import { randomUUID } from "node:crypto";
import { AgentDockError } from "./errors.js";
import { resolveExistingTaskPath } from "./workspace-paths.js";

export const DEFAULT_LIVE_PROCESS_OUTPUT_BYTES = 1024 * 1024;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export class ProcessService {
  #tasks;
  #store;
  #approval;
  #audit;
  #execution;
  #processes = new Map();
  #runtimeId;
  #maxLiveOutputBytes;

  constructor({
    taskService,
    stateStore,
    approvalService,
    auditService,
    executionService,
    maxLiveOutputBytes = DEFAULT_LIVE_PROCESS_OUTPUT_BYTES,
  }) {
    if (!Number.isInteger(maxLiveOutputBytes) || maxLiveOutputBytes < 1024) {
      throw new TypeError("maxLiveOutputBytes must be an integer >= 1024.");
    }
    this.#tasks = taskService;
    this.#store = stateStore;
    this.#approval = approvalService;
    this.#audit = auditService;
    this.#execution = executionService;
    this.#runtimeId = "runtime_" + randomUUID();
    this.#maxLiveOutputBytes = maxLiveOutputBytes;
  }

  #restore(processId) {
    const snapshot = this.#store.loadProcess(processId);
    if (!snapshot) {
      return null;
    }

    const record = {
      ...snapshot,
      output: snapshot.output ?? [],
      output_floor_cursor: snapshot.output_floor_cursor ?? 0,
      next_output_cursor:
        snapshot.next_output_cursor ?? (snapshot.output?.length ?? 0),
      output_total_bytes: snapshot.output_total_bytes ?? 0,
      live_output_bytes: (snapshot.output ?? []).reduce(
        (total, chunk) =>
          total + Buffer.byteLength(String(chunk.text ?? ""), "utf8"),
        0,
      ),
      live_output_truncated: snapshot.live_output_truncated ?? false,
      persisted_output_truncated:
        snapshot.persisted_output_truncated ?? false,
      child: null,
    };

    if (
      (record.status === "RUNNING" || record.status === "CANCELLING") &&
      !processAlive(record.pid)
    ) {
      record.status = "INTERRUPTED";
      record.ended_at ??= new Date().toISOString();
      record.error ??=
        "Persisted process is no longer alive; AgentDock no longer owns it.";
      this.#store.saveProcess(record);
      this.#audit?.append(record.task_id, {
        event: "PROCESS_INTERRUPTED",
        process_id: record.process_id,
        pid: record.pid,
        status: record.status,
        cwd: record.cwd,
        ended_at: record.ended_at,
        reason: record.error,
      });
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

    if (
      !record.child &&
      (record.status === "RUNNING" || record.status === "CANCELLING")
    ) {
      const latest = this.#store.loadProcess(processId);
      if (
        latest &&
        latest.status !== "RUNNING" &&
        latest.status !== "CANCELLING"
      ) {
        Object.assign(record, latest, {
          output: latest.output ?? record.output ?? [],
          child: null,
        });
      } else if (!processAlive(record.pid)) {
        record.status = "INTERRUPTED";
        record.ended_at ??= new Date().toISOString();
        record.error ??=
          "Persisted process is no longer alive; AgentDock no longer owns it.";
        this.#store.saveProcess(record);
        this.#audit?.append(record.task_id, {
          event: "PROCESS_INTERRUPTED",
          process_id: record.process_id,
          pid: record.pid,
          status: record.status,
          cwd: record.cwd,
          ended_at: record.ended_at,
          reason: record.error,
        });
      }
    }

    return record;
  }

  #ownership(record) {
    if (record.child) return "OWNED";
    if (
      (record.status === "RUNNING" || record.status === "CANCELLING") &&
      processAlive(record.pid)
    ) {
      return "EXTERNAL";
    }
    return "HISTORICAL";
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
      execution_plan: record.execution_plan ?? null,
      env: record.env,
      started_at: record.started_at,
      ended_at: record.ended_at,
      exit_code: record.exit_code,
      signal: record.signal,
      error: record.error,
      cancel_requested: record.cancel_requested,
      persisted_output_truncated:
        record.persisted_output_truncated ?? false,
      live_output_truncated: record.live_output_truncated ?? false,
      ownership: this.#ownership(record),
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

  #signalOwned(record, signal) {
    try {
      if (record.pid) {
        process.kill(-record.pid, signal);
      } else {
        record.child?.kill(signal);
      }
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  async #waitForTerminal(record, timeoutMs) {
    const terminal = () =>
      !record.child ||
      !["RUNNING", "CANCELLING"].includes(record.status);

    if (terminal()) return true;

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (terminal()) return true;
    }
    return terminal();
  }

  async shutdownOwned({ graceMs = 5000, killWaitMs = 1000 } = {}) {
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw new TypeError("graceMs must be a non-negative integer.");
    }
    if (!Number.isInteger(killWaitMs) || killWaitMs < 0) {
      throw new TypeError("killWaitMs must be a non-negative integer.");
    }

    const owned = [...this.#processes.values()].filter(
      (record) =>
        record.child &&
        (record.status === "RUNNING" ||
          record.status === "CANCELLING"),
    );

    for (const record of owned) {
      if (record.status === "RUNNING") {
        record.cancel_requested = true;
        record.status = "CANCELLING";
        this.#store.saveProcess(record);
        this.#audit?.append(record.task_id, {
          event: "PROCESS_CANCEL_REQUESTED",
          process_id: record.process_id,
          pid: record.pid,
          status: record.status,
          cwd: record.cwd,
          requested_at: new Date().toISOString(),
          reason: "service_shutdown",
        });
      }
      this.#signalOwned(record, "SIGTERM");
    }

    await Promise.all(
      owned.map((record) =>
        this.#waitForTerminal(record, graceMs),
      ),
    );

    const stubborn = owned.filter(
      (record) =>
        record.child &&
        (record.status === "RUNNING" ||
          record.status === "CANCELLING"),
    );
    for (const record of stubborn) {
      this.#signalOwned(record, "SIGKILL");
    }

    await Promise.all(
      stubborn.map((record) =>
        this.#waitForTerminal(record, killWaitMs),
      ),
    );

    return {
      requested: owned.length,
      forced: stubborn.length,
      processes: owned.map((record) => this.#public(record)),
    };
  }

  async planStart({
    taskId,
    argv,
    shell,
    cwd = ".",
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

    const location = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      cwd,
    );
    const plan = this.#execution.plan({
      scope: location.scope,
      cwd: location.resolved,
    });
    return {
      task_id: taskId,
      cwd: location.resolved,
      cwd_scope: location.scope,
      workspace_root: location.root,
      plan,
    };
  }

  async start({
    taskId,
    argv,
    shell,
    cwd = ".",
    env = {},
    humanConfirmed = false,
    legacyApproval = false,
  }) {
    const prepared = await this.planStart({
      taskId,
      argv,
      shell,
      cwd,
    });
    const location = {
      scope: prepared.cwd_scope,
      resolved: prepared.cwd,
      root: prepared.workspace_root,
    };
    const executionPlan = prepared.plan;
    const hasArgv = Array.isArray(argv);
    const hasShell = typeof shell === "string";

    const authorization = this.#approval?.authorize({
      taskId,
      tool: "process.start",
      shell,
      argv,
      cwd: location.resolved,
      env,
      humanConfirmed:
        executionPlan.guarded_mode === "enforce" &&
        executionPlan.lane === "HOST" &&
        humanConfirmed,
      requirePolicyApproval:
        executionPlan.guarded_mode === "enforce" &&
        executionPlan.lane === "HOST" &&
        legacyApproval,
    });

    const hostAuthorized =
      executionPlan.guarded_mode !== "enforce" ||
      executionPlan.lane !== "HOST" ||
      Boolean(humanConfirmed) ||
      Boolean(authorization?.grant);

    const processId = "proc_" + randomUUID();
    const mode = hasArgv ? "argv" : "shell";
    const launched = this.#execution.launch({
      scope: location.scope,
      cwd: location.resolved,
      workspaceRoot: location.root,
      argv,
      shell,
      env,
      hostAuthorized,
    });
    const child = launched.child;

    this.#audit?.append(taskId, {
      event: "GUARDED_EXECUTION_DECISION",
      process_id: processId,
      guarded_mode: executionPlan.guarded_mode,
      lane: executionPlan.lane,
      decision: executionPlan.decision,
      cwd: executionPlan.cwd,
      network: executionPlan.network,
      hidden_paths: executionPlan.hidden_paths,
      sandbox: executionPlan.sandbox,
      human_confirmed: Boolean(humanConfirmed),
      compatibility_approval: Boolean(authorization?.grant),
    });

    const record = {
      process_id: processId,
      task_id: taskId,
      pid: child.pid ?? null,
      status: "RUNNING",
      mode,
      argv: hasArgv ? [...argv] : undefined,
      shell: hasShell ? shell : undefined,
      cwd: location.resolved,
      cwd_scope: location.scope,
      execution_plan: executionPlan,
      env: { ...env },
      owner_runtime_id: this.#runtimeId,
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      signal: null,
      error: null,
      cancel_requested: false,
      output: [],
      output_floor_cursor: 0,
      next_output_cursor: 0,
      output_total_bytes: 0,
      live_output_bytes: 0,
      live_output_truncated: false,
      persisted_output_truncated: false,
      child,
    };
    this.#processes.set(processId, record);
    this.#store.saveProcess(record);
    this.#tasks.addProcess(taskId, processId);

    this.#audit?.append(taskId, {
      event: "PROCESS_STARTED",
      process_id: processId,
      pid: record.pid,
      mode,
      argv: record.argv,
      shell: record.shell,
      cwd: record.cwd,
      cwd_scope: record.cwd_scope,
      env,
      started_at: record.started_at,
    });

    const append = (stream, chunk) => {
      const text = chunk.toString("utf8");
      const size = Buffer.byteLength(text, "utf8");
      record.output.push({
        cursor: record.next_output_cursor,
        stream,
        text,
      });
      record.next_output_cursor += 1;
      record.output_total_bytes += size;
      record.live_output_bytes = (record.live_output_bytes ?? 0) + size;

      while (
        record.output.length > 1 &&
        record.live_output_bytes > this.#maxLiveOutputBytes
      ) {
        const removed = record.output.shift();
        record.live_output_bytes -= Buffer.byteLength(
          String(removed?.text ?? ""),
          "utf8",
        );
        record.output_floor_cursor = record.output[0]?.cursor ?? record.next_output_cursor;
        record.live_output_truncated = true;
      }

      if (
        record.output.length === 1 &&
        record.live_output_bytes > this.#maxLiveOutputBytes
      ) {
        const only = record.output[0];
        const buffer = Buffer.from(String(only.text ?? ""), "utf8");
        only.text = buffer
          .subarray(Math.max(0, buffer.length - this.#maxLiveOutputBytes))
          .toString("utf8");
        only.partial = true;
        record.live_output_bytes = Buffer.byteLength(only.text, "utf8");
        record.live_output_truncated = true;
      }

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
      this.#audit?.append(taskId, {
        event: "PROCESS_FAILED",
        process_id: processId,
        pid: record.pid,
        status: record.status,
        cwd: record.cwd,
        exit_code: record.exit_code,
        signal: record.signal,
        error: record.error,
        ended_at: record.ended_at,
      });
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
      this.#audit?.append(taskId, {
        event: "PROCESS_ENDED",
        process_id: processId,
        pid: record.pid,
        status: record.status,
        cwd: record.cwd,
        exit_code: record.exit_code,
        signal: record.signal,
        error: record.error,
        ended_at: record.ended_at,
      });
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

    const floor = record.output_floor_cursor ?? 0;
    const next = record.next_output_cursor ?? record.output.length;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > next) {
      throw new AgentDockError(
        "INVALID_OUTPUT_CURSOR",
        "Cursor is outside the available process output range.",
        {
          output_floor_cursor: floor,
          next_cursor: next,
        },
      );
    }

    const effectiveCursor = Math.max(cursor, floor);
    const chunks = record.output.filter(
      (chunk) => (chunk.cursor ?? 0) >= effectiveCursor,
    );

    return {
      process_id: processId,
      task_id: taskId,
      status: record.status,
      cursor,
      effective_cursor: effectiveCursor,
      output_floor_cursor: floor,
      next_cursor: next,
      truncated_before_cursor:
        cursor < floor ||
        (cursor === floor && Boolean(record.output[0]?.partial)),
      persisted_output_truncated:
        record.persisted_output_truncated ?? false,
      live_output_truncated: record.live_output_truncated ?? false,
      ownership: this.#ownership(record),
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
    this.#audit?.append(taskId, {
      event: "PROCESS_CANCEL_REQUESTED",
      process_id: processId,
      pid: record.pid,
      status: record.status,
      cwd: record.cwd,
      requested_at: new Date().toISOString(),
    });

    this.#signalOwned(record, "SIGTERM");

    return this.#public(record);
  }
}
