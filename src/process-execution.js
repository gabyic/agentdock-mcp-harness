import { randomUUID } from "node:crypto";
import { AgentDockError } from "./errors.js";
import { ProcessService } from "./process-service.js";
import { RunSupervisor } from "./run-supervisor.js";
import { SupervisorProcessClient } from "./supervisor-process-client.js";
import { UnixRunSupervisorClient } from "./run-supervisor-ipc.js";

const owners = new Map();

function registryKey(stateStore) {
  return stateStore.databasePath ?? stateStore.stateDir;
}

function ownerFor(stateStore) {
  return owners.get(registryKey(stateStore)) ?? null;
}

export function createProcessExecution({
  mode = "auto",
  taskService,
  stateStore,
  approvalService,
  auditService,
  idempotencyService,
  instanceId,
  leaseHeartbeatMs,
  leaseStaleMs,
  maxLiveOutputBytes,
  supervisorSocket,
} = {}) {
  const key = registryKey(stateStore);
  const requestedMode = mode ?? "auto";
  const existing = ownerFor(stateStore);

  if (requestedMode === "client" && !existing) {
    const remote = new UnixRunSupervisorClient({ socketPath: supervisorSocket });
    const client = new SupervisorProcessClient({
      supervisor: remote,
      stateStore,
    });
    return {
      processService: client,
      supervisor: null,
      supervisorMode: "client",
      supervisorStatus: () => remote.status(),
      close: async () => client.shutdownOwned(),
    };
  }

  if (requestedMode === "client" || (requestedMode === "auto" && existing)) {
    if (!existing) {
      throw new AgentDockError(
        "SUPERVISOR_UNAVAILABLE",
        "Supervisor client mode requires a live Run Supervisor for this state store.",
      );
    }
    const client = new SupervisorProcessClient({
      supervisor: existing.supervisor,
      stateStore,
    });
    return {
      processService: client,
      supervisor: null,
      supervisorMode: "client",
      supervisorStatus: () => existing.supervisor.status(),
      close: async () => client.shutdownOwned(),
    };
  }

  if (requestedMode === "owner" && existing) {
    throw new AgentDockError(
      "SUPERVISOR_ALREADY_RUNNING",
      "A Run Supervisor already owns this state store.",
      { owner_instance_id: existing.supervisor.instanceId },
    );
  }

  const ownerInstanceId =
    instanceId ?? "runtime_" + randomUUID();
  const processService = new ProcessService({
    taskService,
    stateStore,
    approvalService,
    auditService,
    idempotencyService,
    instanceId: ownerInstanceId,
    leaseHeartbeatMs,
    leaseStaleMs,
    maxLiveOutputBytes,
  });
  const supervisor = new RunSupervisor({
    processService,
    stateStore,
  });
  const registration = { supervisor, processService };
  owners.set(key, registration);

  return {
    processService,
    supervisor,
    supervisorMode: "owner",
    supervisorStatus: () => supervisor.status(),
    async close({ graceMs = 5000, killWaitMs = 1000 } = {}) {
      try {
        return await supervisor.shutdown({ graceMs, killWaitMs });
      } finally {
        if (owners.get(key) === registration) {
          owners.delete(key);
        }
      }
    },
  };
}

export function resetRunSupervisorRegistryForTests() {
  owners.clear();
}
