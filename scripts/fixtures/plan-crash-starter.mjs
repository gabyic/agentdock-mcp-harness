import { loadAgentDockConfig } from "../../src/config.js";
import { createAgentDockRuntime } from "../../src/server.js";

const [stateDir, socketPath, taskId] = process.argv.slice(2);
const { config } = loadAgentDockConfig({
  configPath: null,
  env: {
    ...process.env,
    AGENTDOCK_STATE_DIR: stateDir,
    AGENTDOCK_STATE_BACKEND: "sqlite",
    AGENTDOCK_SUPERVISOR_MODE: "client",
    AGENTDOCK_SUPERVISOR_SOCKET: socketPath,
  },
});
const runtime = createAgentDockRuntime({ config });
const plan = runtime.planService.start({
  taskId,
  idempotencyKey: "restart-recovery",
  steps: [{ step_id: "survive", shell: "sleep 1; printf recovered > recovered.txt" }],
});
for (let index = 0; index < 200; index += 1) {
  const current = runtime.planService.get({ taskId, planId: plan.plan_id });
  if (current.current_step_id === "survive") {
    process.stdout.write(JSON.stringify({ plan_id: plan.plan_id }) + "\n");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.exit(2);
