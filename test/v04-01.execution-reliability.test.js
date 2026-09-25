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

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentDock Test",
      GIT_AUTHOR_EMAIL: "agentdock@example.invalid",
      GIT_COMMITTER_NAME: "AgentDock Test",
      GIT_COMMITTER_EMAIL: "agentdock@example.invalid",
    },
  });
  return stdout.trimEnd();
}

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

function makeRuntime(root, stateDir) {
  const { config } = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: { AGENTDOCK_STATE_DIR: stateDir },
  });
  return createAgentDockRuntime({ config });
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition; last=" + JSON.stringify(last));
}

async function waitExited(runtime, taskId, processId) {
  return waitFor(() => {
    const status = runtime.processService.status({
      taskId,
      processId,
    });
    return status.status === "EXITED" ? status : null;
  });
}

async function cleanupRuntime(runtime, taskId) {
  await runtime.processService.shutdownOwned({ graceMs: 100, killWaitMs: 100 });
  const task = runtime.taskService.get(taskId);
  if (task.status === "ACTIVE") {
    runtime.taskService.cancel(taskId);
  }
  await runtime.taskService.cleanup(taskId);
}

test("v0.4 execution reliability: a second runtime observes a live owner without corrupting RUNNING", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-owner-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const owner = makeRuntime(root, stateDir);
  const observer = makeRuntime(root, stateDir);
  const task = await owner.taskService.create({ repoPath: repo });

  t.after(async () => {
    await cleanupRuntime(owner, task.task_id).catch(() => {});
    await observer.processService.shutdownOwned({ graceMs: 0, killWaitMs: 0 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const started = await owner.processService.start({
    taskId: task.task_id,
    argv: [
      process.execPath,
      "-e",
      "setTimeout(() => process.stdout.write('owner-done\\n'), 300)",
    ],
  });

  const observed = observer.processService.status({
    taskId: task.task_id,
    processId: started.process_id,
  });

  assert.equal(observed.status, "RUNNING");
  assert.equal(observed.ownership, "REMOTE");

  await waitExited(owner, task.task_id, started.process_id);

  const observedTerminal = await waitFor(() => {
    const status = observer.processService.status({
      taskId: task.task_id,
      processId: started.process_id,
    });
    return status.status === "EXITED" ? status : null;
  });
  assert.equal(observedTerminal.exit_code, 0);
});

test("v0.4 execution reliability: stale heartbeat with a live owner never corrupts process state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-stale-owner-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const owner = makeRuntime(root, stateDir);
  const observer = makeRuntime(root, stateDir);
  const task = await owner.taskService.create({ repoPath: repo });

  t.after(async () => {
    await cleanupRuntime(owner, task.task_id).catch(() => {});
    await observer.processService.shutdownOwned({ graceMs: 0, killWaitMs: 0 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const started = await owner.processService.start({
    taskId: task.task_id,
    argv: [
      process.execPath,
      "-e",
      "setTimeout(() => process.stdout.write('stale-owner-done\\n'), 300)",
    ],
  });

  owner.stateStore.saveRuntimeLease({
    instance_id: owner.processService.instanceId,
    pid: process.pid,
    started_at: "2000-01-01T00:00:00.000Z",
    heartbeat_at: "2000-01-01T00:00:00.000Z",
  });

  const observed = observer.processService.status({
    taskId: task.task_id,
    processId: started.process_id,
  });

  assert.equal(observed.status, "RUNNING");
  assert.equal(observed.ownership, "REMOTE");
  assert.equal(observed.owner_lease_stale, true);

  await waitExited(owner, task.task_id, started.process_id);
});

test("v0.4 execution reliability: process output is cursor-paged and never returns the whole noisy run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-output-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(async () => {
    await cleanupRuntime(runtime, task.task_id).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const expected = Array.from({ length: 12 }, (_, index) =>
    String(index).padStart(2, "0") + ":" + "x".repeat(8192) + "\n"
  ).join("");

  const code = `
    let i = 0;
    const timer = setInterval(() => {
      if (i >= 12) {
        clearInterval(timer);
        return;
      }
      process.stdout.write(String(i).padStart(2, "0") + ":" + "x".repeat(8192) + "\\n");
      i += 1;
    }, 2);
  `;

  const started = await runtime.processService.start({
    taskId: task.task_id,
    argv: [process.execPath, "-e", code],
  });
  await waitExited(runtime, task.task_id, started.process_id);

  let cursor = 0;
  let collected = "";
  let pages = 0;
  while (true) {
    const page = runtime.processService.output({
      taskId: task.task_id,
      processId: started.process_id,
      cursor,
      maxBytes: 32 * 1024,
      maxChunks: 1,
    });
    pages += 1;
    assert.ok(page.chunks.length <= 1);
    assert.ok(Buffer.byteLength(page.stdout_chunk, "utf8") <= 16 * 1024);
    collected += page.stdout_chunk;
    cursor = page.next_cursor;
    if (!page.has_more) break;
    assert.ok(pages < 100, "pagination must make forward progress");
  }

  assert.ok(pages > 1);
  assert.equal(collected, expected);
});

test("v0.4 execution reliability: resume summaries are compact and bounded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-resume-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(async () => {
    await cleanupRuntime(runtime, task.task_id).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 8; index += 1) {
    const started = await runtime.processService.start({
      taskId: task.task_id,
      argv: [process.execPath, "-e", `process.stdout.write("${index}\\n")`],
    });
    await waitExited(runtime, task.task_id, started.process_id);
  }

  const summaries = runtime.processService.summariesForTask(task.task_id, {
    limit: 3,
    compact: true,
  });

  assert.equal(summaries.length, 3);
  assert.deepEqual(
    summaries.map((entry) => entry.process_id),
    task.process_ids.slice(-3),
  );
  for (const entry of summaries) {
    assert.equal("shell" in entry, false);
    assert.equal("argv" in entry, false);
    assert.equal("env" in entry, false);
  }
});

test("v0.4 execution reliability: wait provides a bounded long-poll primitive for Run adapters", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-wait-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(async () => {
    await cleanupRuntime(runtime, task.task_id).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const started = await runtime.processService.start({
    taskId: task.task_id,
    argv: [
      process.execPath,
      "-e",
      "setTimeout(() => process.stdout.write('run-ready\\n'), 80)",
    ],
  });

  const result = await runtime.processService.wait({
    taskId: task.task_id,
    processId: started.process_id,
    cursor: 0,
    waitMs: 1000,
    maxBytes: 32 * 1024,
    maxChunks: 4,
  });

  assert.match(result.stdout_chunk, /run-ready/);
  assert.ok(["RUNNING", "EXITED"].includes(result.status));
  assert.ok(result.next_cursor > 0);
});
