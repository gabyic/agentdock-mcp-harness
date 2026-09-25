import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "authoritative state\n");
  await execFileAsync("git", ["-C", repo, "add", "-A"]);
  await execFileAsync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=AgentDock Test",
      "-c",
      "user.email=agentdock-test@example.invalid",
      "commit",
      "-m",
      "fixture",
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

async function shutdownRuntime(runtime) {
  await runtime.processService.shutdownOwned({ graceMs: 0, killWaitMs: 0 });
  runtime.stateStore.close?.();
}

test("v0.4 authoritative sqlite Task mutations do not lose concurrent process ids", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-task-race-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const first = makeRuntime(root, stateDir);
  const second = makeRuntime(root, stateDir);
  const verifier = makeRuntime(root, stateDir);
  const task = await first.taskService.create({ repoPath: repo });

  t.after(async () => {
    const latest = verifier.taskService.get(task.task_id);
    if (latest.status === "ACTIVE") {
      verifier.taskService.cancel(task.task_id);
    }
    const finalized = verifier.taskService.get(task.task_id);
    if (
      (finalized.status === "COMPLETED" || finalized.status === "CANCELLED") &&
      !finalized.workspace_cleaned
    ) {
      await verifier.taskService.cleanup(task.task_id);
    }
    await shutdownRuntime(first);
    await shutdownRuntime(second);
    await shutdownRuntime(verifier);
    await rm(root, { recursive: true, force: true });
  });

  // Prime both runtimes before either mutation. The pre-fix Task cache made
  // this exact sequence overwrite one process_ids update with the other.
  first.taskService.get(task.task_id);
  second.taskService.get(task.task_id);

  const processA = "proc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const processB = "proc_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  first.taskService.addProcess(task.task_id, processA);
  second.taskService.addProcess(task.task_id, processB);

  const persisted = verifier.taskService.get(task.task_id);
  assert.deepEqual(
    [...persisted.process_ids].sort(),
    [processA, processB].sort(),
  );
});

test("v0.4 terminal Task state is monotonic across stale runtimes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-terminal-task-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const first = makeRuntime(root, stateDir);
  const stale = makeRuntime(root, stateDir);
  const verifier = makeRuntime(root, stateDir);
  const task = await first.taskService.create({ repoPath: repo });

  t.after(async () => {
    const latest = verifier.taskService.get(task.task_id);
    if (
      (latest.status === "COMPLETED" || latest.status === "CANCELLED") &&
      !latest.workspace_cleaned
    ) {
      await verifier.taskService.cleanup(task.task_id);
    }
    await shutdownRuntime(first);
    await shutdownRuntime(stale);
    await shutdownRuntime(verifier);
    await rm(root, { recursive: true, force: true });
  });

  // Prime the second runtime while ACTIVE to reproduce the previous stale
  // object-cache resurrection path.
  assert.equal(stale.taskService.get(task.task_id).status, "ACTIVE");

  const { stdout } = await execFileAsync(
    "git",
    ["-C", task.worktree_path, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  first.taskService.finish(task.task_id, {
    finalCommitSha: stdout.trim(),
  });

  assert.equal(stale.taskService.get(task.task_id).status, "COMPLETED");

  await assert.rejects(
    () =>
      stale.processService.start({
        taskId: task.task_id,
        shell: "printf should-not-run",
      }),
    (error) => error?.code === "TASK_NOT_ACTIVE",
  );

  assert.throws(
    () => stale.taskService.recordCommit(task.task_id, "deadbeef"),
    (error) => error?.code === "TASK_NOT_ACTIVE",
  );

  const persisted = verifier.taskService.get(task.task_id);
  assert.equal(persisted.status, "COMPLETED");
  assert.deepEqual(persisted.process_ids, []);
});
