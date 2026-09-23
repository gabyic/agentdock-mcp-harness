import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { listenAgentDockHttp } from "../src/http-server.js";
import {
  createAgentDockRuntime,
} from "../src/server.js";
import { DEFAULT_LIVE_PROCESS_OUTPUT_BYTES } from "../src/process-service.js";

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

async function waitFor(check, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition; last=" + JSON.stringify(last));
}

test("v0.4: process output is live-bounded, durable previews are redacted, ownership is cross-runtime safe, and stale Tasks are discoverable", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-process-hygiene-"));
  const repoDir = path.join(tempRoot, "repo");
  const stateDir = path.join(tempRoot, "state");

  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await writeFile(path.join(repoDir, "README.md"), "# test\n");
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const runtime = createAgentDockRuntime({ stateDir });
  const secondRuntime = createAgentDockRuntime({ stateDir });
  const task = await runtime.taskService.create({ repoPath: repoDir });

  let httpInstance;
  let client;
  t.after(async () => {
    try { await client?.close(); } catch {}
    try { await httpInstance?.close(); } catch {}
    try { await runtime.processService.shutdownOwned({ graceMs: 100, killWaitMs: 100 }); } catch {}
    runtime.stateStore.close?.();
    secondRuntime.stateStore.close?.();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const canary = "OUTPUT_TOKEN=PROCESS_HYGIENE_CANARY";
  const code = [
    "const chunk='x'.repeat(32768);",
    "for(let i=0;i<48;i++) process.stdout.write(chunk);",
    "process.stdout.write(' " + canary + "');",
    "process.stderr.write(' password=PROCESS_HYGIENE_STDERR');",
  ].join("");

  const large = await runtime.processService.start({
    taskId: task.task_id,
    argv: [process.execPath, "-e", code],
    cwd: ".",
    env: { API_TOKEN: "PROCESS_HYGIENE_ENV" },
  });

  await waitFor(() => {
    const status = runtime.processService.status({
      taskId: task.task_id,
      processId: large.process_id,
    });
    return status.status === "EXITED" ? status : null;
  });

  const liveOutput = runtime.processService.output({
    taskId: task.task_id,
    processId: large.process_id,
    cursor: 0,
  });
  const liveBytes = Buffer.byteLength(
    liveOutput.stdout_chunk + liveOutput.stderr_chunk,
    "utf8",
  );
  assert.equal(liveOutput.live_output_truncated, true);
  assert.equal(liveOutput.truncated_before_cursor, true);
  assert.ok(liveBytes <= DEFAULT_LIVE_PROCESS_OUTPUT_BYTES + 65536);
  assert.match(liveOutput.stdout_chunk, /PROCESS_HYGIENE_CANARY$/);

  const persistedRaw = await readFile(
    runtime.stateStore.processPath(large.process_id),
    "utf8",
  );
  assert.equal(persistedRaw.includes("PROCESS_HYGIENE_CANARY"), false);
  assert.equal(persistedRaw.includes("PROCESS_HYGIENE_STDERR"), false);
  assert.equal(persistedRaw.includes("PROCESS_HYGIENE_ENV"), false);
  assert.match(persistedRaw, /\[REDACTED\]/);

  const smallSecret = await runtime.processService.start({
    taskId: task.task_id,
    shell:
      "printf 'token=PROCESS_HYGIENE_STDOUT'; printf ' password=PROCESS_HYGIENE_STDERR' >&2",
    cwd: ".",
  });
  await waitFor(() => {
    const status = runtime.processService.status({
      taskId: task.task_id,
      processId: smallSecret.process_id,
    });
    return status.status === "EXITED" ? status : null;
  });
  const smallPersisted = await readFile(
    runtime.stateStore.processPath(smallSecret.process_id),
    "utf8",
  );
  assert.equal(smallPersisted.includes("PROCESS_HYGIENE_STDOUT"), false);
  assert.equal(smallPersisted.includes("PROCESS_HYGIENE_STDERR"), false);
  assert.match(smallPersisted, /\[REDACTED\]/);

  const restored = secondRuntime.processService.status({
    taskId: task.task_id,
    processId: large.process_id,
  });
  assert.equal(restored.status, "EXITED");
  assert.equal(restored.ownership, "HISTORICAL");

  const running = await runtime.processService.start({
    taskId: task.task_id,
    shell: "sleep 1",
    cwd: ".",
  });
  const seenElsewhere = secondRuntime.processService.status({
    taskId: task.task_id,
    processId: running.process_id,
  });
  assert.equal(seenElsewhere.status, "RUNNING");
  assert.equal(seenElsewhere.ownership, "EXTERNAL");

  await waitFor(() => {
    const status = runtime.processService.status({
      taskId: task.task_id,
      processId: running.process_id,
    });
    return status.status === "EXITED" ? status : null;
  });
  const terminalElsewhere = secondRuntime.processService.status({
    taskId: task.task_id,
    processId: running.process_id,
  });
  assert.equal(terminalElsewhere.status, "EXITED");
  assert.equal(terminalElsewhere.ownership, "HISTORICAL");

  runtime.taskService.mutate(task.task_id, (current) => {
    current.updated_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  });

  httpInstance = await listenAgentDockHttp({
    runtime,
    host: "127.0.0.1",
    port: 0,
  });
  client = new Client(
    { name: "agentdock-v04-task-list", version: "0.4.0-dev" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:" + httpInstance.port + httpInstance.mcpPath),
    ),
  );

  const listed = await client.callTool({
    name: "task.list",
    arguments: {
      stale_after_seconds: 60,
      include_finalized: true,
    },
  });
  assert.notEqual(listed.isError, true);
  const found = listed.structuredContent.tasks.find(
    (entry) => entry.task_id === task.task_id,
  );
  assert.ok(found);
  assert.equal(found.status, "ACTIVE");
  assert.equal(found.active_process_count, 0);
  assert.equal(found.stale, true);
  await access(task.worktree_path);
});
