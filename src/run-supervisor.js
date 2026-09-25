import { AgentDockError } from "./errors.js";

export const SUPERVISOR_RUNTIME_ID = "runtime_00000000-0000-4000-8000-000000000001";

function normalizeError(error) {
  if (error instanceof AgentDockError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    };
  }
  return {
    code: "SUPERVISOR_INTERNAL_ERROR",
    message: error?.message ?? String(error),
    details: null,
  };
}

export class RunSupervisor {
  #processes;
  #store;
  #closed = false;

  constructor({ processService, stateStore }) {
    this.#processes = processService;
    this.#store = stateStore;
  }

  get instanceId() {
    return this.#processes.instanceId;
  }

  async request(action, args = {}) {
    if (this.#closed) {
      throw new AgentDockError(
        "SUPERVISOR_UNAVAILABLE",
        "The AgentDock Run Supervisor is not accepting requests.",
      );
    }

    try {
      switch (action) {
        case "start":
          return await this.#processes.start(args);
        case "status":
          return this.#processes.status(args);
        case "output":
          return this.#processes.output(args);
        case "waitOutput":
          return await this.#processes.waitOutput(args);
        case "cancel":
          return this.#processes.cancel(args);
        case "summariesForTask":
          return this.#processes.summariesForTask(args.taskId, args.options);
        case "activeForTask":
          return this.#processes.activeForTask(args.taskId);
        case "cancelAllForTask":
          return this.#processes.cancelAllForTask(args.taskId);
        default:
          throw new AgentDockError(
            "SUPERVISOR_ACTION_UNSUPPORTED",
            "Unsupported Run Supervisor action: " + action,
          );
      }
    } catch (error) {
      const normalized = normalizeError(error);
      throw new AgentDockError(
        normalized.code,
        normalized.message,
        normalized.details ?? undefined,
      );
    }
  }

  status() {
    return {
      mode: "owner",
      instance_id: this.instanceId,
      closed: this.#closed,
    };
  }

  start(args) {
    return this.request("start", args);
  }

  processStatus(args) {
    return this.request("status", args);
  }

  output(args) {
    return this.request("output", args);
  }

  waitOutput(args) {
    return this.request("waitOutput", args);
  }

  cancel(args) {
    return this.request("cancel", args);
  }

  summariesForTask(taskId, options) {
    return this.request("summariesForTask", { taskId, options });
  }

  activeForTask(taskId) {
    return this.request("activeForTask", { taskId });
  }

  cancelAllForTask(taskId) {
    return this.request("cancelAllForTask", { taskId });
  }

  async shutdown({ graceMs = 5000, killWaitMs = 1000 } = {}) {
    if (this.#closed) {
      return {
        requested: 0,
        forced: 0,
        processes: [],
      };
    }
    this.#closed = true;
    return this.#processes.shutdownOwned({ graceMs, killWaitMs });
  }
}

export class RunSupervisorClient {
  #store;
  #resolveOwner;

  constructor({ stateStore, resolveOwner }) {
    this.#store = stateStore;
    this.#resolveOwner = resolveOwner;
  }

  #owner() {
    const owner = this.#resolveOwner?.();
    if (!owner) {
      throw new AgentDockError(
        "SUPERVISOR_UNAVAILABLE",
        "No live AgentDock Run Supervisor is available.",
      );
    }
    return owner;
  }

  get instanceId() {
    return this.#owner().instanceId;
  }

  request(action, args = {}) {
    return this.#owner().request(action, args);
  }

  status() {
    const owner = this.#resolveOwner?.();
    return owner
      ? { mode: "client", owner_instance_id: owner.instanceId, available: true }
      : { mode: "client", owner_instance_id: null, available: false };
  }

  shutdown() {
    return Promise.resolve({
      requested: 0,
      forced: 0,
      processes: [],
      delegated: true,
    });
  }
}
