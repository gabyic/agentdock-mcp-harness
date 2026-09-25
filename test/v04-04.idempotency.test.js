import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IdempotencyService } from "../src/idempotency-service.js";
import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";
import { StateStore } from "../src/state-store.js";

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "idempotency\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync(
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

async function waitTerminal(runtime, taskId, processId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = runtime.processService.status({
      taskId,
      processId,
    });
    if (!["RUNNING", "CANCELLING"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process did not terminate");
}

async function stopRuntime(runtime) {
  await (runtime.closeExecution?.({ graceMs: 1000, killWaitMs: 100 }) ?? runtime.processService.shutdownOwned({ graceMs: 1000, killWaitMs: 100 }));
  runtime.stateStore.close?.();
}

test("v0.4 idempotency: in-flight and terminal retries reuse one Run and one side effect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-idem-run-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  let runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });
  const sideEffectPath = path.join(task.worktree_path, "effect.log");
  const shell = "printf 'effect\\n' >> effect.log; sleep 0.2";

  t.after(async () => {
    try {
      const current = runtime.taskService.get(task.task_id);
      if (current.status === "ACTIVE") runtime.taskService.cancel(task.task_id);
      const finalized = runtime.taskService.get(task.task_id);
      if (
        ["COMPLETED", "CANCELLED"].includes(finalized.status) &&
        !finalized.workspace_cleaned
      ) {
        await runtime.taskService.cleanup(task.task_id);
      }
    } catch {}
    await stopRuntime(runtime).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const first = await runtime.processService.start({
    taskId: task.task_id,
    shell,
    idempotencyKey: "same-run",
  });
  assert.equal(first.idempotent_replay, false);

  const inFlightReplay = await runtime.processService.start({
    taskId: task.task_id,
    shell,
    idempotencyKey: "same-run",
  });
  assert.equal(inFlightReplay.process_id, first.process_id);
  assert.equal(inFlightReplay.idempotent_replay, true);

  const terminal = await waitTerminal(runtime, task.task_id, first.process_id);
  assert.equal(terminal.status, "EXITED");
  assert.equal(terminal.exit_code, 0);

  const terminalReplay = await runtime.processService.start({
    taskId: task.task_id,
    shell,
    idempotencyKey: "same-run",
  });
  assert.equal(terminalReplay.process_id, first.process_id);
  assert.equal(terminalReplay.idempotent_replay, true);
  assert.equal(terminalReplay.status, "EXITED");

  const lines = (await readFile(sideEffectPath, "utf8"))
    .trim()
    .split(/\n/);
  assert.deepEqual(lines, ["effect"]);

  const operations = runtime.stateStore.listDocuments("operation");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].value.run_id, first.process_id);
  assert.equal(operations[0].value.status, "EXITED");
  assert.equal(JSON.stringify(operations).includes("same-run"), false);
});

test("v0.4 idempotency: same key with a different request fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-idem-conflict-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(async () => {
    const current = runtime.taskService.get(task.task_id);
    if (current.status === "ACTIVE") runtime.taskService.cancel(task.task_id);
    await runtime.taskService.cleanup(task.task_id).catch(() => {});
    await stopRuntime(runtime).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const first = await runtime.processService.start({
    taskId: task.task_id,
    shell: "printf first",
    idempotencyKey: "conflict-key",
  });
  await waitTerminal(runtime, task.task_id, first.process_id);

  await assert.rejects(
    () =>
      runtime.processService.start({
        taskId: task.task_id,
        shell: "printf second",
        idempotencyKey: "conflict-key",
      }),
    (error) => error?.code === "IDEMPOTENCY_KEY_REUSED",
  );

  assert.equal(runtime.taskService.get(task.task_id).process_ids.length, 1);
});

test("v0.4 idempotency: retry after runtime restart returns the durable original Run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-idem-restart-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  let runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });
  const shell = "printf 'restart-effect\\n' >> restart.log";

  const first = await runtime.processService.start({
    taskId: task.task_id,
    shell,
    idempotencyKey: "restart-key",
  });
  await waitTerminal(runtime, task.task_id, first.process_id);
  await stopRuntime(runtime);

  runtime = makeRuntime(root, stateDir);

  t.after(async () => {
    const current = runtime.taskService.get(task.task_id);
    if (current.status === "ACTIVE") runtime.taskService.cancel(task.task_id);
    await runtime.taskService.cleanup(task.task_id).catch(() => {});
    await stopRuntime(runtime).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const replay = await runtime.processService.start({
    taskId: task.task_id,
    shell,
    idempotencyKey: "restart-key",
  });

  assert.equal(replay.process_id, first.process_id);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.status, "EXITED");

  const text = await readFile(
    path.join(task.worktree_path, "restart.log"),
    "utf8",
  );
  assert.deepEqual(text.trim().split(/\n/), ["restart-effect"]);
});

test("v0.4 idempotency: retention hard-cap prunes terminal operation records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-idem-retention-"));
  const store = new StateStore({
    stateDir: path.join(root, "state"),
    backend: "sqlite",
  });
  const service = new IdempotencyService({
    stateStore: store,
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    maxRecords: 2,
  });

  t.after(async () => {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 3; index += 1) {
    const claim = service.claim({
      taskId: "task_11111111-1111-4111-8111-111111111111",
      tool: "process.start",
      key: "key-" + index,
      request: { shell: "printf " + index },
      runId: "proc_" + String(index + 1).padStart(8, "0") + "-1111-4111-8111-111111111111",
      ownerInstanceId: "runtime_11111111-1111-4111-8111-111111111111",
    });
    service.mark({
      operationId: claim.operationId,
      runId: claim.operation.run_id,
      status: "EXITED",
    });
  }

  assert.equal(store.listDocuments("operation").length, 2);
});


test("v0.4 idempotency: two live runtimes racing the same key create one Run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-idem-race-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const firstRuntime = makeRuntime(root, stateDir);
  const secondRuntime = makeRuntime(root, stateDir);
  const verifier = makeRuntime(root, stateDir);
  const task = await firstRuntime.taskService.create({ repoPath: repo });
  const shell = "printf 'race-effect\\n' >> race.log; sleep 0.2";

  t.after(async () => {
    try {
      const currentTask = verifier.taskService.get(task.task_id);
      if (currentTask.status === "ACTIVE") {
        verifier.taskService.cancel(task.task_id);
      }
      await verifier.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await stopRuntime(firstRuntime).catch(() => {});
    await stopRuntime(secondRuntime).catch(() => {});
    await stopRuntime(verifier).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    firstRuntime.processService.start({
      taskId: task.task_id,
      shell,
      idempotencyKey: "race-key",
    }),
    secondRuntime.processService.start({
      taskId: task.task_id,
      shell,
      idempotencyKey: "race-key",
    }),
  ]);

  assert.equal(first.process_id, second.process_id);
  assert.equal(
    [first.idempotent_replay, second.idempotent_replay].filter(Boolean).length,
    1,
  );

  let terminal;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    terminal = firstRuntime.processService.status({
      taskId: task.task_id,
      processId: first.process_id,
    });
    if (!["RUNNING", "CANCELLING"].includes(terminal.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(terminal?.status, "EXITED");

  const effect = await readFile(
    path.join(task.worktree_path, "race.log"),
    "utf8",
  );
  assert.deepEqual(effect.trim().split(/\n/), ["race-effect"]);

  const persistedTask = verifier.taskService.get(task.task_id);
  assert.deepEqual(persistedTask.process_ids, [first.process_id]);
});
