import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AgentDockError } from "./errors.js";
import { resolveExistingTaskPath } from "./workspace-paths.js";

const ACTIVE_STATUSES = new Set(["RUNNING", "CANCELLING"]);
const OUTPUT_CHUNK_BYTES = 16 * 1024;
const DEFAULT_OUTPUT_PAGE_BYTES = OUTPUT_CHUNK_BYTES;
const DEFAULT_OUTPUT_PAGE_CHUNKS = 4;
const MAX_OUTPUT_PAGE_BYTES = 32 * 1024;
const MAX_OUTPUT_PAGE_CHUNKS = 128;
const DEFAULT_LIVE_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_LEASE_HEARTBEAT_MS = 1000;
const DEFAULT_LEASE_STALE_MS = 30000;
const REGISTRATION_ABORT_GRACE_MS = 250;
const REGISTRATION_ABORT_KILL_WAIT_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitUtf8Text(text, maxBytes = OUTPUT_CHUNK_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];

  const parts = [];
  let chars = [];
  let bytes = 0;

  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (chars.length > 0 && bytes + size > maxBytes) {
      parts.push(chars.join(""));
      chars = [];
      bytes = 0;
    }
    chars.push(char);
    bytes += size;
  }

  if (chars.length > 0) parts.push(chars.join(""));
  return parts;
}

function outputBytes(chunks) {
  return (chunks ?? []).reduce(
    (total, chunk) => total + Buffer.byteLength(String(chunk.text ?? ""), "utf8"),
    0,
  );
}

function terminalStatus(status) {
  return !ACTIVE_STATUSES.has(status);
}

export class ProcessService {
  #tasks;
  #store;
  #approval;
  #audit;
  #idempotency;
  #processes = new Map();
  #instanceId;
  #instanceStartedAt;
  #leaseHeartbeatMs;
  #leaseStaleMs;
  #leaseTimer;
  #maxLiveOutputBytes;

  constructor({
    taskService,
    stateStore,
    approvalService,
    auditService,
    idempotencyService,
    instanceId,
    leaseHeartbeatMs = DEFAULT_LEASE_HEARTBEAT_MS,
    leaseStaleMs = DEFAULT_LEASE_STALE_MS,
    maxLiveOutputBytes,
  }) {
    this.#tasks = taskService;
    this.#store = stateStore;
    this.#approval = approvalService;
    this.#audit = auditService;
    this.#idempotency = idempotencyService;

    if (!Number.isInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 100) {
      throw new TypeError("leaseHeartbeatMs must be an integer >= 100.");
    }
    if (!Number.isInteger(leaseStaleMs) || leaseStaleMs <= leaseHeartbeatMs) {
      throw new TypeError("leaseStaleMs must be greater than leaseHeartbeatMs.");
    }

    const configuredLiveBytes =
      maxLiveOutputBytes ??
      Math.max(
        DEFAULT_LIVE_OUTPUT_BYTES,
        stateStore.maxPersistedOutputBytes ?? 0,
      );
    if (!Number.isInteger(configuredLiveBytes) || configuredLiveBytes < 64 * 1024) {
      throw new TypeError("maxLiveOutputBytes must be an integer >= 65536.");
    }

    this.#instanceId = instanceId ?? "runtime_" + randomUUID();
    this.#instanceStartedAt = new Date().toISOString();
    this.#leaseHeartbeatMs = leaseHeartbeatMs;
    this.#leaseStaleMs = leaseStaleMs;
    this.#maxLiveOutputBytes = configuredLiveBytes;

    this.#touchLease();
    this.#leaseTimer = setInterval(
      () => this.#touchLease(),
      this.#leaseHeartbeatMs,
    );
    this.#leaseTimer.unref?.();
    this.#recoverPendingProcessStarts();
  }

  get instanceId() {
    return this.#instanceId;
  }

  #touchLease() {
    this.#store.saveRuntimeLease({
      instance_id: this.#instanceId,
      pid: process.pid,
      started_at: this.#instanceStartedAt,
      heartbeat_at: new Date().toISOString(),
    });
  }

  #releaseLease() {
    if (this.#leaseTimer) {
      clearInterval(this.#leaseTimer);
      this.#leaseTimer = null;
    }
    this.#store.deleteRuntimeLease(this.#instanceId);
  }

  #pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "EPERM") return true;
      if (error?.code === "ESRCH") return false;
      return false;
    }
  }

  #ownerState(instanceId) {
    if (!instanceId) return "DEAD";
    if (instanceId === this.#instanceId) return "LOCAL";

    const lease = this.#store.loadRuntimeLease(instanceId);
    if (!lease) return "DEAD";

    if (!this.#pidAlive(Number(lease.pid))) return "DEAD";

    const heartbeatAt = Date.parse(lease.heartbeat_at);
    if (
      !Number.isFinite(heartbeatAt) ||
      Date.now() - heartbeatAt > this.#leaseStaleMs
    ) {
      return "STALE";
    }
    return "ALIVE";
  }

  #recoverPendingProcessStarts(taskId = null) {
    const tasks = taskId ? [this.#tasks.get(taskId)] : this.#tasks.list();
    for (const task of tasks) {
      for (const reservation of task.pending_process_starts ?? []) {
        const processId = reservation?.process_id;
        if (!/^proc_[0-9a-f-]{36}$/.test(String(processId ?? ""))) continue;

        const snapshot = this.#store.loadProcess(processId);
        if (!snapshot || snapshot.task_id !== task.task_id) continue;

        const ownerInstanceId =
          reservation.owner_instance_id ?? snapshot.owner_instance_id ?? null;
        let ownerState;
        try {
          ownerState = this.#ownerState(ownerInstanceId);
        } catch {
          continue;
        }
        if (ownerState !== "DEAD") continue;

        try {
          this.#tasks.addProcess(task.task_id, processId, { reserved: true });
          const recovered = this.#restore(processId);
          try {
            this.#audit?.append(task.task_id, {
              event: "PROCESS_START_REGISTRATION_RECOVERED",
              process_id: processId,
              previous_owner_instance_id: ownerInstanceId,
              recovered_status: recovered?.status ?? snapshot.status ?? null,
              recovered_at: new Date().toISOString(),
            });
          } catch {
            // Registration recovery is authoritative even if diagnostics fail.
          }
        } catch {
          // Preserve the reservation as a durable fail-closed blocker. Hygiene
          // exposes it for operator review instead of guessing that no child ran.
        }
      }
    }
  }

  #syncIdempotency(record, status = record.status) {
    if (!record.idempotency_operation_id || !this.#idempotency) return null;
    return this.#idempotency.mark({
      operationId: record.idempotency_operation_id,
      runId: record.process_id,
      status,
    });
  }

  async #replayIdempotent(operation, taskId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snapshot = this.#store.loadProcess(operation.run_id);
      if (snapshot) {
        const record = this.#get(operation.run_id);
        if (record.task_id !== taskId) {
          throw new AgentDockError(
            "PROCESS_TASK_MISMATCH",
            "Idempotent Run does not belong to this Task.",
          );
        }
        return {
          ...this.#public(record),
          idempotent_replay: true,
        };
      }
      await sleep(25);
    }

    throw new AgentDockError(
      "IDEMPOTENCY_OPERATION_PENDING",
      "The original idempotent Run is still being created. Retry with the same idempotency_key.",
      {
        operation_id: operation.operation_id,
        run_id: operation.run_id,
        status: operation.status,
      },
    );
  }

  #persist(record) {
    const persisted = this.#store.saveProcess(record);
    record.persisted_output_truncated =
      persisted.persisted_output_truncated ?? false;
    record.persisted_output_bytes = persisted.persisted_output_bytes ?? 0;
    return persisted;
  }

  #interruptLostOwner(record) {
    record.status = "INTERRUPTED";
    record.ended_at ??= new Date().toISOString();
    record.error ??=
      "AgentDock restarted or lost ownership of the running process.";
    record.remote_owner = false;
    record.remote_owner_stale = false;
    this.#persist(record);
    this.#syncIdempotency(record, "INTERRUPTED");
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

  #restore(processId) {
    const snapshot = this.#store.loadProcess(processId);
    if (!snapshot) return null;

    const record = {
      ...snapshot,
      output: snapshot.output ?? [],
      output_floor_cursor: snapshot.output_floor_cursor ?? 0,
      next_output_cursor:
        snapshot.next_output_cursor ?? (snapshot.output?.length ?? 0),
      output_total_bytes: snapshot.output_total_bytes ?? 0,
      retained_output_bytes: outputBytes(snapshot.output ?? []),
      persisted_output_truncated:
        snapshot.persisted_output_truncated ?? false,
      live_output_truncated:
        (snapshot.output_floor_cursor ?? 0) > 0,
      child: null,
      remote_owner: false,
      remote_owner_stale: false,
    };

    if (ACTIVE_STATUSES.has(record.status)) {
      if (record.owner_instance_id === this.#instanceId) {
        // A durable record claiming this runtime but lacking the in-memory
        // child handle is never enough proof to signal its PID. Treat it as
        // interrupted rather than guessing from pid liveness.
        this.#interruptLostOwner(record);
      } else {
        const ownerState = record.owner_instance_id
          ? this.#ownerState(record.owner_instance_id)
          : "DEAD";

        if (ownerState === "ALIVE" || ownerState === "STALE") {
          record.remote_owner = true;
          record.remote_owner_stale = ownerState === "STALE";
        } else {
          this.#interruptLostOwner(record);
        }
      }
    }

    this.#processes.set(processId, record);
    return record;
  }

  #get(processId) {
    if (!/^proc_[0-9a-f-]{36}$/.test(processId)) {
      throw new AgentDockError("INVALID_PROCESS_ID", "Invalid process_id format.");
    }

    let record = this.#processes.get(processId);
    if (!record) {
      record = this.#restore(processId);
    } else if (record.remote_owner && ACTIVE_STATUSES.has(record.status)) {
      record = this.#restore(processId);
    }

    if (!record) {
      throw new AgentDockError(
        "PROCESS_NOT_FOUND",
        "Process not found: " + processId,
      );
    }
    return record;
  }

  #ownership(record) {
    if (record.child) return "LOCAL";
    if (record.remote_owner && ACTIVE_STATUSES.has(record.status)) return "REMOTE";
    return "NONE";
  }

  #public(record, { compact = false } = {}) {
    const common = {
      process_id: record.process_id,
      task_id: record.task_id,
      pid: record.pid,
      status: record.status,
      started_at: record.started_at,
      ended_at: record.ended_at,
      exit_code: record.exit_code,
      signal: record.signal,
      error: record.error,
      cancel_requested: record.cancel_requested,
      persisted_output_truncated:
        record.persisted_output_truncated ?? false,
      ownership: this.#ownership(record),
      owner_lease_stale: Boolean(record.remote_owner_stale),
    };

    if (compact) return common;

    return {
      ...common,
      mode: record.mode,
      argv: record.argv,
      shell: record.shell,
      cwd: record.cwd,
      env: record.env,
    };
  }

  summariesForTask(taskId, { limit, compact = false } = {}) {
    this.#recoverPendingProcessStarts(taskId);
    const task = this.#tasks.get(taskId);
    let processIds = task.process_ids ?? [];

    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new TypeError("limit must be an integer between 1 and 1000.");
      }
      processIds = processIds.slice(-limit);
    }

    return processIds.map((processId) => {
      const record = this.#get(processId);
      if (record.task_id !== taskId) {
        throw new AgentDockError(
          "PROCESS_TASK_MISMATCH",
          "Persisted process does not belong to this Task.",
        );
      }
      return this.#public(record, { compact });
    });
  }

  activeForTask(taskId) {
    return this.summariesForTask(taskId, { compact: true }).filter(
      (record) => ACTIVE_STATUSES.has(record.status),
    );
  }

  cancelAllForTask(taskId) {
    this.#recoverPendingProcessStarts(taskId);
    const task = this.#tasks.get(taskId);
    const results = [];
    for (const processId of task.process_ids ?? []) {
      const record = this.#get(processId);
      if (ACTIVE_STATUSES.has(record.status)) {
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
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }

  async #abortUnregisteredStart(record, registrationError, { persisted }) {
    const child = record.child;
    record.cancel_requested = true;
    record.status = "CANCELLING";
    record.error =
      "Run registration failed before ownership became durable: " +
      (registrationError?.message ?? String(registrationError));

    // Drain pipes while termination is in flight so a noisy child cannot block
    // on a full pipe before it observes the termination signal.
    child.stdout?.resume();
    child.stderr?.resume();

    let finalized = false;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    const finalize = (code, signal, childError = null) => {
      if (finalized) return;
      finalized = true;
      record.status = "FAILED";
      record.exit_code = code ?? record.exit_code ?? null;
      record.signal = signal ?? record.signal ?? null;
      record.ended_at = new Date().toISOString();
      if (childError) {
        record.error += "; child error: " + childError.message;
      }
      record.child = null;
      record.remote_owner = false;

      if (persisted) {
        try {
          this.#persist(record);
        } catch {
          // The child is confirmed terminal. Keep repairing Task state below;
          // a stale RUNNING snapshot remains conservative for later GC.
        }
      }

      let registrationRecovered = false;
      if (persisted) {
        try {
          this.#tasks.addProcess(record.task_id, record.process_id, {
            reserved: true,
          });
          registrationRecovered = true;
        } catch {
          // A terminal, unlinked diagnostic record is safe. Release the Task
          // reservation below so a dead child cannot wedge its lifecycle.
        }
      }
      if (!registrationRecovered) {
        try {
          this.#tasks.releaseProcessStart(record.task_id, record.process_id);
        } catch {
          // A leftover reservation fails closed and is surfaced by hygiene.
        }
      }

      try {
        this.#syncIdempotency(record, "FAILED");
      } catch {
        // Preserve the registration error and terminal ownership result.
      }
      try {
        this.#audit?.append(record.task_id, {
          event: "PROCESS_START_REGISTRATION_FAILED",
          process_id: record.process_id,
          owner_instance_id: this.#instanceId,
          status: record.status,
          exit_code: record.exit_code,
          signal: record.signal,
          error: record.error,
          ended_at: record.ended_at,
        });
      } catch {
        // Durable process/Task state remains authoritative without audit output.
      }
      this.#processes.delete(record.process_id);
      resolveClosed(true);
    };

    child.once("error", (error) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finalize(child.exitCode, child.signalCode, error);
      } else {
        record.error += "; child error: " + error.message;
      }
    });
    child.once("close", (code, signal) => finalize(code, signal));

    if (child.exitCode !== null || child.signalCode !== null) {
      finalize(child.exitCode, child.signalCode);
      return { terminated: true, forced: false };
    }

    if (persisted) {
      try {
        this.#persist(record);
      } catch {
        // The reservation remains the authoritative fail-closed guard.
      }
    }

    let forced = false;
    try {
      this.#signalOwned(record, "SIGTERM");
    } catch {
      // Continue to the bounded wait and SIGKILL fallback.
    }
    let terminated = await Promise.race([
      closed,
      sleep(REGISTRATION_ABORT_GRACE_MS).then(() => false),
    ]);

    if (!terminated) {
      forced = true;
      try {
        this.#signalOwned(record, "SIGKILL");
      } catch {
        // If signalling cannot be proven, retain the reservation indefinitely.
      }
      terminated = await Promise.race([
        closed,
        sleep(REGISTRATION_ABORT_KILL_WAIT_MS).then(() => false),
      ]);
    }

    return { terminated, forced };
  }

  async #waitForTerminal(record, timeoutMs) {
    const terminal = () =>
      !record.child || !ACTIVE_STATUSES.has(record.status);

    if (terminal()) return true;

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(25);
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
      (record) => record.child && ACTIVE_STATUSES.has(record.status),
    );

    for (const record of owned) {
      if (record.status === "RUNNING") {
        record.cancel_requested = true;
        record.status = "CANCELLING";
        this.#persist(record);
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
      owned.map((record) => this.#waitForTerminal(record, graceMs)),
    );

    const stubborn = owned.filter(
      (record) => record.child && ACTIVE_STATUSES.has(record.status),
    );
    for (const record of stubborn) {
      this.#signalOwned(record, "SIGKILL");
    }

    await Promise.all(
      stubborn.map((record) => this.#waitForTerminal(record, killWaitMs)),
    );

    this.#releaseLease();

    return {
      requested: owned.length,
      forced: stubborn.length,
      processes: owned.map((record) => this.#public(record)),
    };
  }

  #trimLiveOutput(record) {
    while (
      record.retained_output_bytes > this.#maxLiveOutputBytes &&
      record.output.length > 1
    ) {
      const removed = record.output.shift();
      record.retained_output_bytes -= Buffer.byteLength(
        String(removed?.text ?? ""),
        "utf8",
      );
      record.live_output_truncated = true;
    }

    record.output_floor_cursor =
      record.output.length > 0
        ? record.output[0].cursor
        : record.next_output_cursor;
  }

  async start({
    taskId,
    argv,
    shell,
    cwd = ".",
    env = {},
    idempotencyKey,
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

    const mode = hasArgv ? "argv" : "shell";
    const idempotencyRequest = {
      task_id: taskId,
      tool: "process.start",
      mode,
      argv: hasArgv ? [...argv] : null,
      shell: hasShell ? shell : null,
      cwd: cwd ?? ".",
      env: { ...env },
    };

    if (idempotencyKey !== undefined) {
      if (!this.#idempotency) {
        throw new AgentDockError(
          "IDEMPOTENCY_UNAVAILABLE",
          "Durable idempotency is not configured for this runtime.",
        );
      }
      const existing = this.#idempotency.lookup({
        taskId,
        tool: "process.start",
        key: idempotencyKey,
        request: idempotencyRequest,
      });
      if (existing.operation) {
        return this.#replayIdempotent(existing.operation, taskId);
      }
    }

    this.#recoverPendingProcessStarts(taskId);
    this.#tasks.assertActive(taskId);

    const location = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      cwd,
    );

    this.#approval?.authorize({
      taskId,
      tool: "process.start",
      shell,
      argv,
      cwd: location.resolved,
      env,
    });

    let processId = "proc_" + randomUUID();
    let operationId = null;
    let startReserved = false;

    this.#tasks.reserveProcessStart(taskId, processId, {
      ownerInstanceId: this.#instanceId,
    });
    startReserved = true;

    if (idempotencyKey !== undefined) {
      try {
        const claim = this.#idempotency.claim({
          taskId,
          tool: "process.start",
          key: idempotencyKey,
          request: idempotencyRequest,
          runId: processId,
          ownerInstanceId: this.#instanceId,
        });
        if (!claim.created) {
          this.#tasks.releaseProcessStart(taskId, processId);
          startReserved = false;
          return this.#replayIdempotent(claim.operation, taskId);
        }
        if (claim.operation.run_id !== processId) {
          throw new AgentDockError(
            "IDEMPOTENCY_RUN_ID_MISMATCH",
            "A newly claimed Run must keep its reserved process identity.",
            {
              reserved_process_id: processId,
              claimed_process_id: claim.operation.run_id ?? null,
            },
          );
        }
        operationId = claim.operationId;
      } catch (error) {
        if (startReserved) {
          this.#tasks.releaseProcessStart(taskId, processId);
        }
        throw error;
      }
    }

    const command = hasArgv ? argv[0] : shell;
    const args = hasArgv ? argv.slice(1) : [];
    let child;
    try {
      child = spawn(command, args, {
        cwd: location.resolved,
        env: { ...process.env, ...env },
        shell: hasShell,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (startReserved) {
        this.#tasks.releaseProcessStart(taskId, processId);
      }
      if (operationId) {
        this.#idempotency.mark({
          operationId,
          runId: processId,
          status: "FAILED",
        });
      }
      throw error;
    }

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
      env: { ...env },
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      signal: null,
      error: null,
      cancel_requested: false,
      owner_instance_id: this.#instanceId,
      owner_pid: process.pid,
      idempotency_operation_id: operationId,
      output: [],
      output_floor_cursor: 0,
      next_output_cursor: 0,
      output_total_bytes: 0,
      retained_output_bytes: 0,
      persisted_output_truncated: false,
      live_output_truncated: false,
      remote_owner: false,
      remote_owner_stale: false,
      child,
    };
    let processPersisted = false;
    try {
      this.#processes.set(processId, record);
      this.#persist(record);
      processPersisted = true;
      this.#tasks.addProcess(taskId, processId, { reserved: true });
      startReserved = false;
    } catch (error) {
      await this.#abortUnregisteredStart(record, error, {
        persisted: processPersisted,
      });
      throw error;
    }
    this.#syncIdempotency(record, "RUNNING");

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
      owner_instance_id: this.#instanceId,
      idempotency_operation_id: operationId,
    });

    const append = (stream, chunk) => {
      const text = chunk.toString("utf8");
      for (const part of splitUtf8Text(text)) {
        const size = Buffer.byteLength(part, "utf8");
        record.output.push({
          cursor: record.next_output_cursor,
          stream,
          text: part,
        });
        record.next_output_cursor += 1;
        record.output_total_bytes += size;
        record.retained_output_bytes += size;
      }
      this.#trimLiveOutput(record);
      this.#persist(record);
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error) => {
      record.status = "FAILED";
      record.error = error.message;
      record.ended_at = new Date().toISOString();
      record.child = null;
      record.remote_owner = false;
      this.#persist(record);
      this.#syncIdempotency(record, "FAILED");
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
      record.remote_owner = false;
      this.#persist(record);
      this.#syncIdempotency(record, record.status);
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

    const result = this.#public(record);
    if (idempotencyKey !== undefined) {
      result.idempotent_replay = false;
    }
    return result;
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

  output({
    taskId,
    processId,
    cursor = 0,
    maxBytes = DEFAULT_OUTPUT_PAGE_BYTES,
    maxChunks = DEFAULT_OUTPUT_PAGE_CHUNKS,
  }) {
    const record = this.#get(processId);
    if (record.task_id !== taskId) {
      throw new AgentDockError(
        "PROCESS_TASK_MISMATCH",
        "Process does not belong to this Task.",
      );
    }

    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < OUTPUT_CHUNK_BYTES ||
      maxBytes > MAX_OUTPUT_PAGE_BYTES
    ) {
      throw new AgentDockError(
        "INVALID_OUTPUT_PAGE_SIZE",
        "max_bytes must be an integer between 16384 and 32768.",
      );
    }
    if (
      !Number.isInteger(maxChunks) ||
      maxChunks < 1 ||
      maxChunks > MAX_OUTPUT_PAGE_CHUNKS
    ) {
      throw new AgentDockError(
        "INVALID_OUTPUT_PAGE_CHUNKS",
        "max_chunks must be an integer between 1 and 128.",
      );
    }

    const floor = record.output_floor_cursor ?? 0;
    const availableEnd = record.next_output_cursor ?? record.output.length;
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      cursor > availableEnd
    ) {
      throw new AgentDockError(
        "INVALID_OUTPUT_CURSOR",
        "Cursor is outside the available process output range.",
        {
          output_floor_cursor: floor,
          available_next_cursor: availableEnd,
        },
      );
    }

    const effectiveCursor = Math.max(cursor, floor);
    const available = record.output.filter(
      (chunk) => (chunk.cursor ?? 0) >= effectiveCursor,
    );

    const chunks = [];
    let bytes = 0;
    for (const chunk of available) {
      if (chunks.length >= maxChunks) break;
      const size = Buffer.byteLength(String(chunk.text ?? ""), "utf8");
      if (chunks.length > 0 && bytes + size > maxBytes) break;
      chunks.push(chunk);
      bytes += size;
    }

    const nextCursor =
      chunks.length > 0
        ? (chunks[chunks.length - 1].cursor ?? effectiveCursor) + 1
        : effectiveCursor;
    const hasMore = available.some(
      (chunk) => (chunk.cursor ?? 0) >= nextCursor,
    );

    return {
      process_id: processId,
      task_id: taskId,
      status: record.status,
      cursor,
      effective_cursor: effectiveCursor,
      output_floor_cursor: floor,
      next_cursor: nextCursor,
      available_next_cursor: availableEnd,
      has_more: hasMore,
      truncated_before_cursor: cursor < floor,
      live_output_truncated: record.live_output_truncated ?? false,
      persisted_output_truncated:
        record.persisted_output_truncated ?? false,
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

  async wait({
    taskId,
    processId,
    cursor = 0,
    waitMs = 5000,
    maxBytes = DEFAULT_OUTPUT_PAGE_BYTES,
    maxChunks = DEFAULT_OUTPUT_PAGE_CHUNKS,
  }) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) {
      throw new AgentDockError(
        "INVALID_WAIT_TIMEOUT",
        "wait_ms must be an integer between 0 and 10000.",
      );
    }

    const deadline = Date.now() + waitMs;
    while (true) {
      const page = this.output({
        taskId,
        processId,
        cursor,
        maxBytes,
        maxChunks,
      });
      if (
        page.chunks.length > 0 ||
        terminalStatus(page.status) ||
        Date.now() >= deadline
      ) {
        return {
          ...page,
          poll_after_ms: terminalStatus(page.status) ? 0 : 1000,
        };
      }
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  cancel({ taskId, processId }) {
    const record = this.#get(processId);
    if (record.task_id !== taskId) {
      throw new AgentDockError(
        "PROCESS_TASK_MISMATCH",
        "Process does not belong to this Task.",
      );
    }

    if (record.remote_owner && ACTIVE_STATUSES.has(record.status)) {
      throw new AgentDockError(
        "PROCESS_NOT_OWNED",
        "The process is owned by another live AgentDock runtime.",
        {
          process_id: processId,
          status: record.status,
          ownership: "REMOTE",
        },
      );
    }

    if (record.status !== "RUNNING") {
      return this.#public(record);
    }

    record.cancel_requested = true;
    record.status = "CANCELLING";
    this.#persist(record);
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
