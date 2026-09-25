#!/usr/bin/env node
import { loadAgentDockConfig } from "./config.js";
import { createAgentDockRuntime } from "./server.js";
import { listenRunSupervisor } from "./run-supervisor-ipc.js";

const { config } = loadAgentDockConfig({
  overrides: { execution: { supervisor_mode: "owner" } },
});
const runtime = createAgentDockRuntime({ config });
const listener = await listenRunSupervisor({
  supervisor: runtime.runSupervisor,
  socketPath: config.execution.supervisor_socket,
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`AgentDock Run Supervisor stopping after ${signal}.`);
  await listener.close().catch(() => {});
  await runtime.closeExecution?.({ graceMs: 5000, killWaitMs: 1000 });
  runtime.stateStore.close?.();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
}

console.error(`AgentDock Run Supervisor listening on ${listener.socketPath}`);
