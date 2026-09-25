import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(prefix, policyRules = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AgentDock Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  const stateDir = path.join(root, "state");
  const { config } = loadAgentDockConfig({ homeDir: root, configPath: null, env: { AGENTDOCK_STATE_DIR: stateDir, AGENTDOCK_STATE_BACKEND: "sqlite", AGENTDOCK_POLICY_JSON: JSON.stringify(policyRules) } });
  return { root, repo, runtime: createAgentDockRuntime({ config }) };
}

async function waitPlan(runtime, taskId, planId, statuses, attempts = 500) {
  for (let index = 0; index < attempts; index += 1) {
    const plan = runtime.planService.get({ taskId, planId });
    if (statuses.includes(plan.status)) return plan;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Plan did not reach: " + statuses.join(", "));
}

async function dispose(runtime, taskId, root) {
  try {
    const task = runtime.taskService.get(taskId);
    if (task.status === "ACTIVE") runtime.taskService.cancel(taskId);
    await runtime.taskService.cleanup(taskId).catch(() => {});
  } catch {}
  await runtime.closeExecution?.({ graceMs: 1000, killWaitMs: 100 }).catch(() => {});
  runtime.stateStore.close?.();
  await rm(root, { recursive: true, force: true });
}

test("v0.4 full Plan runs dependencies, evidence, reasoning barrier, commit, and verified finish", async (t) => {
  const { root, repo, runtime } = await fixture("agentdock-v04-full-plan-");
  const task = await runtime.taskService.create({ repoPath: repo, completionContract: { required: ["TARGETED_TESTS"] } });
  t.after(() => dispose(runtime, task.task_id, root));
  const started = runtime.planService.start({
    taskId: task.task_id,
    idempotencyKey: "full-plan",
    steps: [
      { step_id: "edit", shell: "printf 'planned\\n' > result.txt" },
      { step_id: "commit", action: "GIT_COMMIT", depends_on: ["edit"], message: "planned result" },
      { step_id: "verify", shell: "test \"$(cat result.txt)\" = planned", depends_on: ["commit"], evidence: { kind: "TARGETED_TESTS", summary: "Targeted result check passed." } },
      { step_id: "reason", action: "REASONING_BARRIER", depends_on: ["verify"], prompt: "Confirm the deterministic evidence is sufficient." },
      { step_id: "finish", action: "TASK_FINISH", depends_on: ["reason"], outcome: "COMMIT" },
    ],
  });
  let waiting = await waitPlan(runtime, task.task_id, started.plan_id, ["AWAITING_ASSISTANT"]);
  assert.equal(waiting.blocker.code, "PLAN_REASONING_REQUIRED");
  assert.equal(waiting.last_successful_step_id, "verify");
  assert.equal(waiting.steps.find((step) => step.step_id === "verify").evidence.kind, "TARGETED_TESTS");
  runtime.planService.continue({ taskId: task.task_id, planId: started.plan_id, stepId: "reason", note: "Evidence reviewed." });
  const completed = await waitPlan(runtime, task.task_id, started.plan_id, ["COMPLETED"]);
  assert.equal(completed.last_successful_step_id, "finish");
  const finished = runtime.taskService.get(task.task_id);
  assert.equal(finished.status, "COMPLETED");
  assert.equal(finished.verification_status, "VERIFIED");
  assert.equal(finished.outcome, "COMMIT");
});

test("v0.4 full Plan retries only explicitly safe steps and exposes durable attempts", async (t) => {
  const { root, repo, runtime } = await fixture("agentdock-v04-plan-retry-");
  const task = await runtime.taskService.create({ repoPath: repo });
  t.after(() => dispose(runtime, task.task_id, root));
  assert.throws(() => runtime.planService.start({ taskId: task.task_id, idempotencyKey: "unsafe", steps: [{ step_id: "bad", shell: "exit 1", retry: { safe: false, max_attempts: 2 } }] }), { code: "INVALID_PLAN_STEP" });
  const plan = runtime.planService.start({
    taskId: task.task_id,
    idempotencyKey: "safe-retry",
    steps: [{ step_id: "flaky", shell: "if test -f attempt; then exit 0; else touch attempt; exit 9; fi", retry: { safe: true, max_attempts: 2 } }],
  });
  const completed = await waitPlan(runtime, task.task_id, plan.plan_id, ["READY_TO_COMMIT"]);
  assert.equal(completed.steps[0].status, "PASSED");
  assert.equal(completed.steps[0].attempts, 2);

  const failed = runtime.planService.start({
    taskId: task.task_id,
    idempotencyKey: "failed-evidence",
    steps: [{ step_id: "known-failure", shell: "exit 4", evidence: { kind: "TARGETED_TESTS", summary: "Targeted check result." } }],
  });
  const blocked = await waitPlan(runtime, task.task_id, failed.plan_id, ["AWAITING_ASSISTANT"]);
  assert.equal(blocked.steps[0].evidence.status, "FAIL");
  assert.throws(() => runtime.planService.continue({ taskId: task.task_id, planId: failed.plan_id, stepId: "known-failure" }), { code: "PLAN_REPAIR_REQUIRED" });
});

test("v0.4 full Plan rejects missing and cyclic dependencies", async (t) => {
  const { root, repo, runtime } = await fixture("agentdock-v04-plan-deps-");
  const task = await runtime.taskService.create({ repoPath: repo });
  t.after(() => dispose(runtime, task.task_id, root));
  assert.throws(() => runtime.planService.start({ taskId: task.task_id, idempotencyKey: "missing", steps: [{ step_id: "one", shell: "true", depends_on: ["absent"] }] }), { code: "INVALID_PLAN_DEPENDENCY" });
  assert.throws(() => runtime.planService.start({ taskId: task.task_id, idempotencyKey: "cycle", steps: [{ step_id: "one", shell: "true", depends_on: ["two"] }, { step_id: "two", shell: "true", depends_on: ["one"] }] }), { code: "INVALID_PLAN_DEPENDENCY" });
});

test("v0.4 full Plan exposes and resumes an explicit human barrier", async (t) => {
  const { root, repo, runtime } = await fixture("agentdock-v04-plan-human-");
  const task = await runtime.taskService.create({ repoPath: repo });
  t.after(() => dispose(runtime, task.task_id, root));
  const plan = runtime.planService.start({ taskId: task.task_id, idempotencyKey: "human", steps: [
    { step_id: "confirm", action: "HUMAN_BARRIER", prompt: "Confirm the deployment window." },
    { step_id: "after", shell: "printf confirmed > confirmed.txt" },
  ] });
  const waiting = await waitPlan(runtime, task.task_id, plan.plan_id, ["AWAITING_USER"]);
  assert.equal(waiting.current_step_id, "confirm");
  assert.equal(waiting.blocker.code, "PLAN_HUMAN_CONFIRMATION_REQUIRED");
  runtime.planService.continue({ taskId: task.task_id, planId: plan.plan_id, stepId: "confirm", note: "Window confirmed." });
  const completed = await waitPlan(runtime, task.task_id, plan.plan_id, ["READY_TO_COMMIT"]);
  assert.equal(completed.last_successful_step_id, "after");
});

test("v0.4 full Plan waits for durable approval and continues only after a grant", async (t) => {
  const rules = [{ id: "plan-approval", effect: "ask", tool: "process.start", shell_regex: "^printf approved", approval_scope: "plan-test" }];
  const { root, repo, runtime } = await fixture("agentdock-v04-plan-approval-", rules);
  const task = await runtime.taskService.create({ repoPath: repo });
  t.after(() => dispose(runtime, task.task_id, root));
  const plan = runtime.planService.start({ taskId: task.task_id, idempotencyKey: "approval", steps: [{ step_id: "approved", shell: "printf approved > approved.txt" }] });
  const waiting = await waitPlan(runtime, task.task_id, plan.plan_id, ["AWAITING_APPROVAL"]);
  const approvalId = waiting.blocker.approval_request.approval_id;
  runtime.approvalService.respond({ taskId: task.task_id, approvalId, decision: "ALLOW_ONCE" });
  runtime.planService.continue({ taskId: task.task_id, planId: plan.plan_id, stepId: "approved", note: "Approval granted." });
  const completed = await waitPlan(runtime, task.task_id, plan.plan_id, ["READY_TO_COMMIT"]);
  assert.equal(completed.steps[0].status, "PASSED");
});

test("v0.4 full Plan recovers after its transport process exits while Supervisor retains the Run", async (t) => {
  const root = await mkdtemp("/tmp/agentdock-plan-recovery-");
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  const socketPath = path.join(stateDir, "supervisor.sock");
  await mkdir(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const daemon = spawn(process.execPath, [path.join(projectRoot, "src", "supervisor.js")], {
    env: { ...process.env, HOME: root, AGENTDOCK_STATE_DIR: stateDir, AGENTDOCK_STATE_BACKEND: "sqlite", AGENTDOCK_SUPERVISOR_SOCKET: socketPath },
    stdio: ["ignore", "ignore", "ignore"],
  });
  let recovery;
  let task;
  t.after(async () => {
    try {
      if (task && recovery?.taskService.get(task.task_id).status === "ACTIVE") recovery.taskService.cancel(task.task_id);
      await recovery?.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await recovery?.closeExecution?.().catch(() => {});
    recovery?.stateStore.close?.();
    daemon.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 300; index += 1) {
    try { await access(socketPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const { config } = loadAgentDockConfig({ configPath: null, env: { ...process.env, AGENTDOCK_STATE_DIR: stateDir, AGENTDOCK_STATE_BACKEND: "sqlite", AGENTDOCK_SUPERVISOR_MODE: "client", AGENTDOCK_SUPERVISOR_SOCKET: socketPath } });
  const setup = createAgentDockRuntime({ config });
  task = await setup.taskService.create({ repoPath: repo });
  await setup.closeExecution?.();
  setup.stateStore.close?.();
  const { stdout } = await execFileAsync(process.execPath, [path.join(projectRoot, "test", "fixtures", "plan-crash-starter.mjs"), stateDir, socketPath, task.task_id], { encoding: "utf8" });
  const { plan_id: planId } = JSON.parse(stdout.trim());
  recovery = createAgentDockRuntime({ config });
  const completed = await waitPlan(recovery, task.task_id, planId, ["READY_TO_COMMIT"], 600);
  assert.equal(completed.steps[0].status, "PASSED");
  assert.equal((await readFile(path.join(task.worktree_path, "recovered.txt"), "utf8")), "recovered");
});
