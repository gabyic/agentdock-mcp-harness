import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "minimal plan runner\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync(
    "git",
    [
      "-C", repo,
      "-c", "user.name=AgentDock Test",
      "-c", "user.email=agentdock-test@example.invalid",
      "commit", "-m", "fixture",
    ],
  );
  return repo;
}

function makeRuntime(root, stateDir) {
  const { config } = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
    },
  });
  return createAgentDockRuntime({ config });
}

async function waitPlan(runtime, taskId, planId, statuses) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const plan = runtime.planService.get({ taskId, planId });
    if (statuses.includes(plan.status)) return plan;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("plan did not reach expected status");
}

async function cleanup(runtime, taskId, root) {
  try {
    const task = runtime.taskService.get(taskId);
    if (task.status === "ACTIVE") runtime.taskService.cancel(taskId);
    const finalized = runtime.taskService.get(taskId);
    if (
      ["COMPLETED", "CANCELLED"].includes(finalized.status) &&
      !finalized.workspace_cleaned
    ) {
      await runtime.taskService.cleanup(taskId);
    }
  } catch {}
  await (runtime.closeExecution?.({ graceMs: 1000, killWaitMs: 100 }) ?? runtime.processService.shutdownOwned({ graceMs: 1000, killWaitMs: 100 }))
    .catch(() => {});
  runtime.stateStore.close?.();
  await rm(root, { recursive: true, force: true });
}

test("v0.4 minimal plan runner continues deterministic steps after start returns", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-plan-pass-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(() => cleanup(runtime, task.task_id, root));

  const startedAt = Date.now();
  const plan = runtime.planService.start({
    taskId: task.task_id,
    idempotencyKey: "verify-pass",
    steps: [
      {
        step_id: "first",
        shell: "sleep 0.2; printf 'first\\n' >> plan.log",
      },
      {
        step_id: "second",
        shell: "printf 'second\\n' >> plan.log",
      },
      {
        step_id: "verify",
        shell: "test -f plan.log && grep -q second plan.log",
      },
    ],
  });

  assert.equal(plan.status, "RUNNING");
  assert.equal(plan.idempotent_replay, false);
  assert.ok(Date.now() - startedAt < 150, "plan.start should return before the slow first step finishes");

  const finished = await waitPlan(
    runtime,
    task.task_id,
    plan.plan_id,
    ["READY_TO_COMMIT"],
  );
  assert.equal(finished.status, "READY_TO_COMMIT");
  assert.equal(finished.current_step_id, null);
  assert.equal(finished.last_successful_step_id, "verify");
  assert.deepEqual(
    finished.steps.map((step) => step.status),
    ["PASSED", "PASSED", "PASSED"],
  );

  const lines = (
    await readFile(path.join(task.worktree_path, "plan.log"), "utf8")
  )
    .trim()
    .split(/\n/);
  assert.deepEqual(lines, ["first", "second"]);
  assert.equal(runtime.planService.latestForTask(task.task_id).plan_id, plan.plan_id);
});

test("v0.4 minimal plan runner retry is idempotent and does not duplicate steps", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-plan-idem-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(() => cleanup(runtime, task.task_id, root));

  const request = {
    taskId: task.task_id,
    idempotencyKey: "same-plan",
    steps: [
      {
        step_id: "effect",
        shell: "printf 'effect\\n' >> effect.log; sleep 0.15",
      },
    ],
  };

  const first = runtime.planService.start(request);
  const replay = runtime.planService.start(request);
  assert.equal(replay.plan_id, first.plan_id);
  assert.equal(replay.idempotent_replay, true);

  await waitPlan(runtime, task.task_id, first.plan_id, ["READY_TO_COMMIT"]);

  const lines = (
    await readFile(path.join(task.worktree_path, "effect.log"), "utf8")
  )
    .trim()
    .split(/\n/);
  assert.deepEqual(lines, ["effect"]);

  assert.throws(
    () =>
      runtime.planService.start({
        ...request,
        steps: [{ step_id: "different", shell: "printf different" }],
      }),
    (error) => error?.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("v0.4 minimal plan runner stops on failure and never executes later steps", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-plan-fail-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(() => cleanup(runtime, task.task_id, root));

  const plan = runtime.planService.start({
    taskId: task.task_id,
    idempotencyKey: "verify-fail",
    steps: [
      { step_id: "before", shell: "printf 'before\\n' >> fail.log" },
      { step_id: "failure", shell: "exit 7" },
      { step_id: "must-not-run", shell: "printf 'after\\n' >> fail.log" },
    ],
  });

  const stopped = await waitPlan(
    runtime,
    task.task_id,
    plan.plan_id,
    ["AWAITING_ASSISTANT"],
  );

  assert.equal(stopped.blocker.code, "PLAN_STEP_FAILED");
  assert.equal(stopped.blocker.step_id, "failure");
  assert.equal(stopped.blocker.exit_code, 7);
  assert.deepEqual(
    stopped.steps.map((step) => step.status),
    ["PASSED", "FAILED", "PENDING"],
  );

  const text = await readFile(path.join(task.worktree_path, "fail.log"), "utf8");
  assert.equal(text.trim(), "before");
});

test("v0.4 minimal plan runner keeps one owner runtime across exact cross-runtime retries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-plan-owner-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const owner = makeRuntime(root, stateDir);
  const observer = makeRuntime(root, stateDir);
  const task = await owner.taskService.create({ repoPath: repo });

  t.after(async () => {
    await cleanup(owner, task.task_id, root).catch(() => {});
    await observer.processService
      .shutdownOwned({ graceMs: 1000, killWaitMs: 100 })
      .catch(() => {});
    observer.stateStore.close?.();
  });

  const request = {
    taskId: task.task_id,
    idempotencyKey: "cross-runtime-plan",
    steps: [
      {
        step_id: "effect",
        shell: "sleep 0.2; printf 'owner-effect\\n' >> owner.log",
      },
    ],
  };

  const first = owner.planService.start(request);
  const replay = observer.planService.start(request);

  assert.equal(replay.plan_id, first.plan_id);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.owner_instance_id, owner.processService.instanceId);
  assert.equal(observer.supervisorMode, "client");
  assert.equal(observer.processService.instanceId, owner.processService.instanceId);

  await waitPlan(owner, task.task_id, first.plan_id, ["READY_TO_COMMIT"]);

  const lines = (
    await readFile(path.join(task.worktree_path, "owner.log"), "utf8")
  )
    .trim()
    .split(/\n/);
  assert.deepEqual(lines, ["owner-effect"]);
});

test("v0.4 minimal plan runner cancellation is durable and stops a locally owned Run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-plan-cancel-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(() => cleanup(runtime, task.task_id, root));

  const plan = runtime.planService.start({
    taskId: task.task_id,
    idempotencyKey: "cancel-plan",
    steps: [
      {
        step_id: "slow",
        shell: "sleep 2; printf 'should-not-write\\n' >> cancelled.log",
      },
      {
        step_id: "never",
        shell: "printf 'never\\n' >> cancelled.log",
      },
    ],
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = runtime.planService.get({
      taskId: task.task_id,
      planId: plan.plan_id,
    });
    if (current.current_step_id === "slow") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  runtime.planService.cancel({
    taskId: task.task_id,
    planId: plan.plan_id,
  });

  const cancelled = await waitPlan(
    runtime,
    task.task_id,
    plan.plan_id,
    ["CANCELLED"],
  );
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.blocker.code, "PLAN_CANCELLED");

  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(
    () => readFile(path.join(task.worktree_path, "cancelled.log"), "utf8"),
    (error) => error?.code === "ENOENT",
  );
});
