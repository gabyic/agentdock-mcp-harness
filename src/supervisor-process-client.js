import { AgentDockError } from "./errors.js";

function assertTaskMatch(record, taskId) {
  if (record.task_id !== taskId) {
    throw new AgentDockError(
      "PROCESS_TASK_MISMATCH",
      "Process does not belong to this Task.",
    );
  }
}

export class SupervisorProcessClient {
  #supervisor;
  #store;

  constructor({ supervisor, stateStore }) {
    this.#supervisor = supervisor;
    this.#store = stateStore;
  }

  get instanceId() {
    return this.#supervisor.instanceId;
  }

  start(args) {
    return this.#supervisor.request("start", args);
  }

  status({ taskId, processId }) {
    return this.#supervisor.request("status", { taskId, processId });
  }

  output(args) {
    return this.#supervisor.request("output", args);
  }

  waitOutput(args) {
    return this.#supervisor.request("waitOutput", args);
  }

  wait(args) {
    return this.#supervisor.request("waitOutput", args);
  }

  cancel(args) {
    return this.#supervisor.request("cancel", args);
  }

  summariesForTask(taskId, options) {
    return this.#supervisor.request("summariesForTask", { taskId, options });
  }

  activeForTask(taskId) {
    return this.#supervisor.request("activeForTask", { taskId });
  }

  cancelAllForTask(taskId) {
    return this.#supervisor.request("cancelAllForTask", { taskId });
  }

  shutdownOwned() {
    return Promise.resolve({
      requested: 0,
      forced: 0,
      processes: [],
      delegated: true,
    });
  }

  statusSnapshot({ taskId, processId }) {
    const record = this.#store.loadProcess(processId);
    if (!record) {
      throw new AgentDockError(
        "PROCESS_NOT_FOUND",
        "Process not found: " + processId,
      );
    }
    assertTaskMatch(record, taskId);
    return record;
  }
}
