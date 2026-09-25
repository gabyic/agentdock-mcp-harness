import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentDockError } from "../src/errors.js";
import { createAgentDockRuntime } from "../src/server.js";
import { TaskActivityService } from "../src/task-activity-service.js";

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AgentDock Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "run start safety\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "fixture"]);
  return repo;
}

async function stopRuntime(runtime) {
  if (!runtime) return;
  await runtime.closeExecution?.({ graceMs: 100, killWaitMs: 100 }).catch(() => {});
  runtime.stateStore.close?.();
}

async function finalizeTasks(runtime, tasks) {
  for (const created of tasks) {
    try {
      const current = runtime.taskService.get(created.task_id);
      for (const reservation of current.pending_process_starts ?? []) {
        runtime.taskService.releaseProcessStart(current.task_id, reservation.process_id);
      }
      if (runtime.taskService.get(created.task_id).status === "ACTIVE") {
        runtime.taskService.cancel(created.task_id);
      }
      await runtime.taskService.cleanup(created.task_id).catch(() => {});
    } catch {}
  }
}

function processSnapshot({ processId, task, ownerInstanceId, status = "RUNNING" }) {
  return {
    process_id: processId,
    task_id: task.task_id,
    pid: null,
    status,
    mode: "argv",
    argv: [process.execPath, "-e", ""],
    cwd: task.worktree_path,
    env: {},
    started_at: "2020-01-01T00:00:00.000Z",
    ended_at: status === "RUNNING" ? null : "2020-01-01T00:00:01.000Z",
    exit_code: status === "RUNNING" ? null : 0,
    signal: null,
    error: null,
    cancel_requested: false,
    owner_instance_id: ownerInstanceId,
    owner_pid: null,
    idempotency_operation_id: null,
    output: [],
    output_floor_cursor: 0,
    next_output_cursor: 0,
    output_total_bytes: 0,
  };
}

test("v0.4 failed Run registration proves child termination before releasing its Task reservation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-start-abort-"));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const task = await runtime.taskService.create({ repoPath: repo });
  const childReadyPath = path.join(root, "child-ready");
  t.after(async () => {
    await finalizeTasks(runtime, [task]);
    await stopRuntime(runtime);
    await rm(root, { recursive: true, force: true });
  });

  const originalAddProcess = runtime.taskService.addProcess.bind(runtime.taskService);
  let registrationAttempts = 0;
  runtime.taskService.addProcess = (...args) => {
    registrationAttempts += 1;
    if (registrationAttempts === 1) {
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 2000;
      while (!existsSync(childReadyPath) && Date.now() < deadline) {
        Atomics.wait(waitArray, 0, 0, 10);
      }
      throw new AgentDockError(
        "INJECTED_REGISTRATION_FAILURE",
        "injected durable Task registration failure",
      );
    }
    return originalAddProcess(...args);
  };

  await assert.rejects(
    runtime.processService.start({
      taskId: task.task_id,
      argv: [
        process.execPath,
        "-e",
        [
          "const fs = require('node:fs')",
          "process.on('SIGTERM', () => {})",
          "fs.writeFileSync(" + JSON.stringify(childReadyPath) + ", 'ready')",
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
    }),
    { code: "INJECTED_REGISTRATION_FAILURE" },
  );

  const repaired = runtime.taskService.get(task.task_id);
  assert.deepEqual(repaired.pending_process_starts, []);
  assert.equal(repaired.process_ids.length, 1);
  const processId = repaired.process_ids[0];
  const durable = runtime.stateStore.loadProcess(processId);
  assert.equal(durable.status, "FAILED");
  assert.ok(durable.ended_at);
  assert.equal(durable.signal, "SIGKILL");
  assert.equal(runtime.processService.activeForTask(task.task_id).length, 0);
});

test("v0.4 a pending Run registration outranks a nominally RUNNING Plan", () => {
  const activity = new TaskActivityService().derive({
    task: {
      task_id: "task_00000000-0000-4000-8000-000000000010",
      status: "ACTIVE",
      pending_process_starts: [{
        process_id: "proc_00000000-0000-4000-8000-000000000010",
        owner_instance_id: "runtime_00000000-0000-4000-8000-000000000010",
        reserved_at: "2020-01-01T00:00:00.000Z",
      }],
      approvals: [],
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    },
    processes: [],
    activeProcesses: [],
    latestPlan: {
      plan_id: "plan_pending_start",
      status: "RUNNING",
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    },
  });

  assert.equal(activity.activity_state, "EXECUTING");
  assert.equal(activity.current_blocker.code, "RUN_START_PENDING");
  assert.equal(activity.recommended_next_action, "WAIT_FOR_PROCESS");
});

test("v0.4 dead-owner reservations recover only from matching durable Runs and remain diagnosable otherwise", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-start-recovery-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  let runtime = createAgentDockRuntime({ stateDir });
  const recoverable = await runtime.taskService.create({ repoPath: repo });
  const ambiguous = await runtime.taskService.create({ repoPath: repo });
  const liveOwner = await runtime.taskService.create({ repoPath: repo });
  const tasks = [recoverable, ambiguous, liveOwner];
  const deadOwnerId = "runtime_00000000-0000-4000-8000-000000000011";
  const liveOwnerId = "runtime_00000000-0000-4000-8000-000000000012";
  const recoveredProcessId = "proc_00000000-0000-4000-8000-000000000011";
  const ambiguousProcessId = "proc_00000000-0000-4000-8000-000000000012";
  const liveProcessId = "proc_00000000-0000-4000-8000-000000000013";

  t.after(async () => {
    runtime.stateStore.deleteRuntimeLease(liveOwnerId);
    await finalizeTasks(runtime, tasks);
    await stopRuntime(runtime);
    await rm(root, { recursive: true, force: true });
  });

  runtime.taskService.reserveProcessStart(recoverable.task_id, recoveredProcessId, {
    ownerInstanceId: deadOwnerId,
  });
  runtime.stateStore.saveProcess(processSnapshot({
    processId: recoveredProcessId,
    task: recoverable,
    ownerInstanceId: deadOwnerId,
  }));

  runtime.taskService.reserveProcessStart(ambiguous.task_id, ambiguousProcessId, {
    ownerInstanceId: deadOwnerId,
  });
  runtime.taskService.mutate(ambiguous.task_id, (task) => {
    task.updated_at = "2020-01-01T00:00:00.000Z";
  });

  runtime.taskService.reserveProcessStart(liveOwner.task_id, liveProcessId, {
    ownerInstanceId: liveOwnerId,
  });
  runtime.stateStore.saveProcess(processSnapshot({
    processId: liveProcessId,
    task: liveOwner,
    ownerInstanceId: liveOwnerId,
    status: "EXITED",
  }));
  runtime.stateStore.saveRuntimeLease({
    instance_id: liveOwnerId,
    pid: process.pid,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  });

  await stopRuntime(runtime);
  runtime = createAgentDockRuntime({ stateDir });

  const recoveredTask = runtime.taskService.get(recoverable.task_id);
  assert.deepEqual(recoveredTask.pending_process_starts, []);
  assert.deepEqual(recoveredTask.process_ids, [recoveredProcessId]);
  assert.equal(runtime.stateStore.loadProcess(recoveredProcessId).status, "INTERRUPTED");

  const ambiguousTask = runtime.taskService.get(ambiguous.task_id);
  assert.equal(ambiguousTask.process_ids.includes(ambiguousProcessId), false);
  assert.equal(ambiguousTask.pending_process_starts[0].owner_instance_id, deadOwnerId);
  assert.throws(
    () => runtime.taskService.cancel(ambiguous.task_id),
    { code: "TASK_PROCESS_START_PENDING" },
  );

  const liveTask = runtime.taskService.get(liveOwner.task_id);
  assert.equal(liveTask.process_ids.includes(liveProcessId), false);
  assert.equal(liveTask.pending_process_starts[0].owner_instance_id, liveOwnerId);

  runtime.stateStore.saveDocument("plan", "plan_pending_start", {
    plan_id: "plan_pending_start",
    task_id: ambiguous.task_id,
    status: "RUNNING",
    steps: [],
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
  });

  const listing = await runtime.taskHygieneService.list({ staleAfterSeconds: 60 });
  const ambiguousSummary = listing.tasks.find((item) => item.task_id === ambiguous.task_id);
  const pendingBlocker = ambiguousSummary.blockers.find(
    (blocker) => blocker.code === "RUN_START_PENDING",
  );
  assert.equal(ambiguousSummary.pending_process_start_count, 1);
  assert.equal(ambiguousSummary.current_blocker.code, "RUN_START_PENDING");
  assert.equal(pendingBlocker.reservations[0].owner_instance_id, deadOwnerId);
  assert.equal(pendingBlocker.reservations[0].durable_process_status, null);
  assert.equal(pendingBlocker.reservations[0].owner_heartbeat_at, null);

  const liveSummary = listing.tasks.find((item) => item.task_id === liveOwner.task_id);
  assert.equal(liveSummary.pending_process_starts[0].durable_process_status, "EXITED");
  assert.ok(liveSummary.pending_process_starts[0].owner_heartbeat_at);

  const reconcile = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  const attention = reconcile.needs_attention.find(
    (item) => item.task_id === ambiguous.task_id,
  );
  assert.equal(attention.reason, "RUN_START_PENDING_REVIEW_REQUIRED");
  assert.equal(
    attention.blockers.some((blocker) => blocker.code === "RUN_START_PENDING"),
    true,
  );

  runtime.stateStore.deleteRuntimeLease(liveOwnerId);
  assert.equal(runtime.processService.activeForTask(liveOwner.task_id).length, 0);
  const recoveredAfterOwnerExit = runtime.taskService.get(liveOwner.task_id);
  assert.deepEqual(recoveredAfterOwnerExit.pending_process_starts, []);
  assert.deepEqual(recoveredAfterOwnerExit.process_ids, [liveProcessId]);
});
