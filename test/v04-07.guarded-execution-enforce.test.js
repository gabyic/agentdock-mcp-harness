import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { loadAgentDockConfig } from "../src/config.js";
import { listenAgentDockHttp } from "../src/http-server.js";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentDock Test",
      GIT_AUTHOR_EMAIL: "agentdock@example.invalid",
      GIT_COMMITTER_NAME: "AgentDock Test",
      GIT_COMMITTER_EMAIL: "agentdock@example.invalid",
    },
  });
}

async function createRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

async function fakeSafeBwrap(root) {
  const wrapper = path.join(root, "bwrap-safe-wrapper");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      "  printf 'bubblewrap 0.12.0\\n'",
      "  exit 0",
      "fi",
      "exec /usr/bin/bwrap \"$@\"",
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function waitForRuntimeExit(runtime, taskId, processId) {
  for (let i = 0; i < 150; i += 1) {
    const status = runtime.processService.status({
      taskId,
      processId,
    });
    if (!["RUNNING", "CANCELLING"].includes(status.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process did not exit");
}

async function waitForClientExit(client, taskId, processId) {
  for (let i = 0; i < 150; i += 1) {
    const result = await client.callTool({
      name: "process.status",
      arguments: {
        task_id: taskId,
        process_id: processId,
      },
    });
    const status = result.structuredContent;
    if (!["RUNNING", "CANCELLING"].includes(status.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process did not exit");
}

async function missing(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function configFor(root, extraEnv = {}) {
  return loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: path.join(root, "state"),
      AGENTDOCK_GUARDED_EXECUTION_MODE: "enforce",
      ...extraEnv,
    },
  }).config;
}

test("v0.4: enforce workspace lane runs inside the validated sandbox", async (t) => {
  try {
    await access("/usr/bin/bwrap");
  } catch {
    t.skip("bubblewrap is not installed on this test host");
    return;
  }

  const root = await mkdtemp(
    path.join(os.homedir(), ".agentdock-v04-sandbox-"),
  );
  const secret = await mkdtemp(
    path.join(os.homedir(), ".agentdock-v04-secret-"),
  );
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(secret, "secret.txt"), "hidden\n");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(secret, { recursive: true, force: true });
  });

  const repo = await createRepo(root);
  const wrapper = await fakeSafeBwrap(root);
  const config = configFor(root, {
    AGENTDOCK_SANDBOX_BINARY: wrapper,
    AGENTDOCK_SANDBOX_NETWORK: "deny",
    AGENTDOCK_SANDBOX_HIDDEN_PATHS: secret,
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });

  const shell = [
    "set -eu",
    "printf inside > sandbox-inside.txt",
    "if printf blocked > " + JSON.stringify(path.join(outside, "blocked.txt")) + " 2>/dev/null; then echo outside_write_blocked=no; else echo outside_write_blocked=yes; fi",
    "if test -r " + JSON.stringify(path.join(secret, "secret.txt")) + "; then echo secret_hidden=no; else echo secret_hidden=yes; fi",
    "if node -e \"const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:53});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),300);\"; then echo network_blocked=yes; else echo network_blocked=no; fi",
    "printf 'no_new_privs='; awk '/NoNewPrivs/{print $2}' /proc/self/status",
  ].join("; ");

  const started = await runtime.processService.start({
    taskId: task.task_id,
    shell,
    cwd: ".",
  });
  assert.equal(started.execution_plan.lane, "WORKSPACE");
  assert.equal(started.execution_plan.decision, "sandbox");

  const exited = await waitForRuntimeExit(
    runtime,
    task.task_id,
    started.process_id,
  );
  assert.equal(exited.exit_code, 0);

  const output = runtime.processService.output({
    taskId: task.task_id,
    processId: started.process_id,
    cursor: 0,
  });
  assert.match(output.stdout_chunk, /outside_write_blocked=yes/);
  assert.match(output.stdout_chunk, /secret_hidden=yes/);
  assert.match(output.stdout_chunk, /network_blocked=yes/);
  assert.match(output.stdout_chunk, /no_new_privs=1/);

  assert.equal(await missing(path.join(outside, "blocked.txt")), true);
  const inside = await runtime.fileQueryService.read({
    taskId: task.task_id,
    filePath: "sandbox-inside.txt",
  });
  assert.equal(inside.content, "inside");

  runtime.stateStore.close?.();
});

test("v0.4: host process uses MCP human confirmation and unsupported client fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-host-mrtr-"));
  const hostDir = path.join(root, "host");
  await mkdir(hostDir);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repo = await createRepo(root);
  const wrapper = await fakeSafeBwrap(root);
  const config = configFor(root, {
    AGENTDOCK_SANDBOX_BINARY: wrapper,
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });

  const instance = await listenAgentDockHttp({
    runtime,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await instance.close();
    runtime.stateStore.close?.();
  });

  const url = new URL(
    "http://127.0.0.1:" + instance.port + instance.mcpPath,
  );
  let confirmations = 0;
  const supported = new Client(
    { name: "guarded-supported", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  supported.setRequestHandler("elicitation/create", async () => {
    confirmations += 1;
    return {
      action: "accept",
      content: { confirm: true },
    };
  });
  await supported.connect(new StreamableHTTPClientTransport(url));
  t.after(async () => {
    await supported.close().catch(() => {});
  });

  const marker = path.join(hostDir, "confirmed.txt");
  const started = await supported.callTool({
    name: "process.start",
    arguments: {
      task_id: task.task_id,
      shell: "printf x >> " + JSON.stringify(marker),
      cwd: hostDir,
    },
  });
  assert.notEqual(started.isError, true);
  assert.equal(confirmations, 1);
  const processRecord = started.structuredContent;
  const exited = await waitForClientExit(
    supported,
    task.task_id,
    processRecord.process_id,
  );
  assert.equal(exited.exit_code, 0);
  assert.equal(await readFile(marker, "utf8"), "x");

  const unsupported = new Client(
    { name: "guarded-unsupported", version: "0.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await unsupported.connect(new StreamableHTTPClientTransport(url));
  t.after(async () => {
    await unsupported.close().catch(() => {});
  });

  const blockedMarker = path.join(hostDir, "unsupported.txt");
  let caught = null;
  try {
    await unsupported.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        shell: "printf no > " + JSON.stringify(blockedMarker),
        cwd: hostDir,
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, -32021);
  assert.equal(await missing(blockedMarker), true);
});

test("v0.4: host file mutation confirms before filesystem side effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-host-file-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repo = await createRepo(root);
  const wrapper = await fakeSafeBwrap(root);
  const config = configFor(root, {
    AGENTDOCK_SANDBOX_BINARY: wrapper,
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });
  const instance = await listenAgentDockHttp({
    runtime,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await instance.close();
    runtime.stateStore.close?.();
  });
  const url = new URL(
    "http://127.0.0.1:" + instance.port + instance.mcpPath,
  );

  const unsupported = new Client(
    { name: "guarded-file-unsupported", version: "0.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await unsupported.connect(new StreamableHTTPClientTransport(url));
  t.after(async () => {
    await unsupported.close().catch(() => {});
  });

  const blockedParent = path.join(root, "must-not-exist");
  const blockedFile = path.join(blockedParent, "blocked.txt");
  let blocked = null;
  try {
    await unsupported.callTool({
      name: "file.write",
      arguments: {
        task_id: task.task_id,
        path: blockedFile,
        content: "blocked\n",
      },
    });
  } catch (error) {
    blocked = error;
  }
  assert.equal(blocked?.code, -32021);
  assert.equal(await missing(blockedParent), true);

  const supported = new Client(
    { name: "guarded-file-supported", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  supported.setRequestHandler("elicitation/create", async () => ({
    action: "accept",
    content: { confirm: true },
  }));
  await supported.connect(new StreamableHTTPClientTransport(url));
  t.after(async () => {
    await supported.close().catch(() => {});
  });

  const allowedFile = path.join(root, "allowed", "file.txt");
  const written = await supported.callTool({
    name: "file.write",
    arguments: {
      task_id: task.task_id,
      path: allowedFile,
      content: "allowed\n",
    },
  });
  assert.notEqual(written.isError, true);
  assert.equal(await readFile(allowedFile, "utf8"), "allowed\n");
});

test("v0.4: legacy host confirmation requires explicit ask policy", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-legacy-host-"));
  const hostDir = path.join(root, "host");
  await mkdir(hostDir);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repo = await createRepo(root);
  const wrapper = await fakeSafeBwrap(root);
  const config = configFor(root, {
    AGENTDOCK_SANDBOX_BINARY: wrapper,
    AGENTDOCK_POLICY_JSON: JSON.stringify([
      {
        id: "legacy-host",
        effect: "ask",
        tool: "process.start",
        approval_scope: "legacy-host",
      },
    ]),
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });
  const instance = await listenAgentDockHttp({
    runtime,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await instance.close();
    runtime.stateStore.close?.();
  });
  const url = new URL(
    "http://127.0.0.1:" + instance.port + instance.mcpPath,
  );
  const client = new Client(
    { name: "guarded-legacy", version: "0.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(new StreamableHTTPClientTransport(url));
  t.after(async () => {
    await client.close().catch(() => {});
  });

  const marker = path.join(hostDir, "legacy.txt");
  const first = await client.callTool({
    name: "process.start",
    arguments: {
      task_id: task.task_id,
      shell: "printf legacy > " + JSON.stringify(marker),
      cwd: hostDir,
      confirmation_mode: "legacy_approval",
    },
  });
  assert.equal(first.isError, true);
  assert.equal(
    first.structuredContent.error.code,
    "APPROVAL_REQUIRED",
  );
  assert.equal(await missing(marker), true);

  const approval =
    first.structuredContent.error.details.approval_request;
  const approved = await client.callTool({
    name: "approval.respond",
    arguments: {
      task_id: task.task_id,
      approval_id: approval.approval_id,
      decision: "ALLOW_ONCE",
    },
  });
  assert.notEqual(approved.isError, true);

  const second = await client.callTool({
    name: "process.start",
    arguments: {
      task_id: task.task_id,
      shell: "printf legacy > " + JSON.stringify(marker),
      cwd: hostDir,
      confirmation_mode: "legacy_approval",
    },
  });
  assert.notEqual(second.isError, true);
  const exited = await waitForClientExit(
    client,
    task.task_id,
    second.structuredContent.process_id,
  );
  assert.equal(exited.exit_code, 0);
  assert.equal(await readFile(marker, "utf8"), "legacy");
});
