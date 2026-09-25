import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AgentDock Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "supervisor\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "fixture"]);
  return repo;
}

function runtime(root, stateDir, mode = "auto", socketPath) {
  const { config } = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
      AGENTDOCK_SUPERVISOR_MODE: mode,
      ...(socketPath ? { AGENTDOCK_SUPERVISOR_SOCKET: socketPath } : {}),
    },
  });
  return createAgentDockRuntime({ config });
}

async function waitForPath(target) {
  for (let i = 0; i < 200; i += 1) {
    try {
      await access(target);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("path did not appear: " + target);
}

async function waitTerminal(runtime, taskId, processId) {
  for (let i = 0; i < 200; i += 1) {
    const status = await runtime.processService.status({ taskId, processId });
    if (!["RUNNING", "CANCELLING"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process did not terminate");
}

async function close(runtime) {
  await runtime.closeExecution?.({ graceMs: 1000, killWaitMs: 100 }).catch(() => {});
  runtime.stateStore.close?.();
}

test("v0.4 single supervisor: auto runtimes share one execution owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-supervisor-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const owner = runtime(root, stateDir);
  const client = runtime(root, stateDir);
  const task = await owner.taskService.create({ repoPath: repo });

  t.after(async () => {
    try {
      if (owner.taskService.get(task.task_id).status === "ACTIVE") {
        owner.taskService.cancel(task.task_id);
      }
      await owner.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await close(client);
    await close(owner);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(owner.supervisorMode, "owner");
  assert.equal(client.supervisorMode, "client");
  assert.equal(client.processService.instanceId, owner.processService.instanceId);

  const started = await client.processService.start({
    taskId: task.task_id,
    shell: "sleep 0.15; printf supervisor-ok",
  });
  const observed = await owner.processService.status({
    taskId: task.task_id,
    processId: started.process_id,
  });
  assert.equal(observed.ownership, "LOCAL");

  const terminal = await waitTerminal(client, task.task_id, started.process_id);
  assert.equal(terminal.status, "EXITED");
  const output = await client.processService.output({
    taskId: task.task_id,
    processId: started.process_id,
    cursor: 0,
  });
  assert.match(output.stdout_chunk, /supervisor-ok/);
});

test("v0.4 single supervisor: a client runtime can cancel the owner Run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-supervisor-cancel-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const owner = runtime(root, stateDir);
  const client = runtime(root, stateDir);
  const task = await owner.taskService.create({ repoPath: repo });

  t.after(async () => {
    try {
      if (owner.taskService.get(task.task_id).status === "ACTIVE") {
        owner.taskService.cancel(task.task_id);
      }
      await owner.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await close(client);
    await close(owner);
    await rm(root, { recursive: true, force: true });
  });

  const started = await owner.processService.start({
    taskId: task.task_id,
    shell: "sleep 10",
  });
  const cancelled = await client.processService.cancel({
    taskId: task.task_id,
    processId: started.process_id,
  });
  assert.equal(cancelled.cancel_requested, true);

  const terminal = await waitTerminal(owner, task.task_id, started.process_id);
  assert.equal(terminal.status, "CANCELLED");
});

test("v0.4 single supervisor: persisted PID metadata can never authorize signalling an unrelated process", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-supervisor-pid-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const owner = runtime(root, stateDir);
  const task = await owner.taskService.create({ repoPath: repo });
  const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });

  t.after(async () => {
    try { process.kill(-unrelated.pid, "SIGKILL"); } catch {}
    try {
      if (owner.taskService.get(task.task_id).status === "ACTIVE") {
        owner.taskService.cancel(task.task_id);
      }
      await owner.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await close(owner);
    await rm(root, { recursive: true, force: true });
  });

  const processId = "proc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  owner.stateStore.saveProcess({
    process_id: processId,
    task_id: task.task_id,
    pid: unrelated.pid,
    status: "RUNNING",
    mode: "shell",
    shell: "old-command",
    cwd: task.worktree_path,
    env: {},
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    signal: null,
    error: null,
    cancel_requested: false,
    owner_instance_id: owner.processService.instanceId,
    owner_pid: process.pid,
    output: [],
    output_floor_cursor: 0,
    next_output_cursor: 0,
    output_total_bytes: 0,
    live_output_truncated: false,
    persisted_output_truncated: false,
  });
  owner.taskService.addProcess(task.task_id, processId);

  const interrupted = await owner.processService.cancel({
    taskId: task.task_id,
    processId,
  });
  assert.equal(interrupted.status, "INTERRUPTED");
  assert.equal(interrupted.pid, unrelated.pid);

  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  const durable = owner.stateStore.loadProcess(processId);
  assert.equal(durable.status, "INTERRUPTED");
});

test("v0.4 single supervisor: explicit second owner fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-supervisor-owner-"));
  const stateDir = path.join(root, "state");
  await makeRepo(root);
  const owner = runtime(root, stateDir, "owner");

  t.after(async () => {
    await close(owner);
    await rm(root, { recursive: true, force: true });
  });

  assert.throws(
    () => runtime(root, stateDir, "owner"),
    (error) => error?.code === "SUPERVISOR_ALREADY_RUNNING",
  );
});

test("v0.4 single supervisor: separate Linux processes share Run status, output, and cancel over UDS", async (t) => {
  // Unix-domain socket paths are limited to roughly 104 bytes on macOS.
  const root = await mkdtemp("/tmp/agentdock-ipc-");
  const stateDir = path.join(root, "state");
  const socketPath = path.join(stateDir, "supervisor.sock");
  const repo = await makeRepo(root);
  const setup = runtime(root, stateDir, "auto");
  const task = await setup.taskService.create({ repoPath: repo });
  await close(setup);

  const daemonEnv = { ...process.env };
  delete daemonEnv.AGENTDOCK_CONFIG;
  const daemon = spawn(process.execPath, [
    new URL("../src/supervisor.js", import.meta.url).pathname,
  ], {
    env: {
      ...daemonEnv,
      HOME: root,
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
      AGENTDOCK_SUPERVISOR_SOCKET: socketPath,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  let client;
  t.after(async () => {
    try {
      if (client && client.taskService.get(task.task_id).status === "ACTIVE") {
        client.taskService.cancel(task.task_id);
      }
      await client?.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await close(client).catch(() => {});
    try { daemon.kill("SIGTERM"); } catch {}
    await new Promise((resolve) => daemon.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  });

  await waitForPath(socketPath);
  client = runtime(root, stateDir, "client", socketPath);
  assert.equal(client.supervisorMode, "client");

  const started = await client.processService.start({
    taskId: task.task_id,
    shell: "printf ipc-started; sleep 10",
  });
  assert.equal(started.status, "RUNNING");

  let output;
  for (let i = 0; i < 100; i += 1) {
    output = await client.processService.output({
      taskId: task.task_id,
      processId: started.process_id,
      cursor: 0,
    });
    if (output.stdout_chunk.includes("ipc-started")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(output.stdout_chunk, /ipc-started/);

  const cancelled = await client.processService.cancel({
    taskId: task.task_id,
    processId: started.process_id,
  });
  assert.equal(cancelled.cancel_requested, true);
  const terminal = await waitTerminal(client, task.task_id, started.process_id);
  assert.equal(terminal.status, "CANCELLED");
  assert.notEqual(daemon.pid, process.pid);
});
