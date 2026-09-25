import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";
import { StateStore } from "../src/state-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AgentDock Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "ticket 05\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "fixture"]);
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

async function waitForExit(runtime, taskId, processId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = runtime.processService.status({
      taskId,
      processId,
    });
    if (!["RUNNING", "CANCELLING"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process did not reach terminal state");
}

async function cleanupRuntime(runtime, taskIds, root) {
  for (const taskId of taskIds) {
    try {
      const task = runtime.taskService.get(taskId);
      if (task.status === "ACTIVE") runtime.taskService.cancel(taskId);
      const latest = runtime.taskService.get(taskId);
      if (
        ["COMPLETED", "CANCELLED"].includes(latest.status) &&
        !latest.workspace_cleaned
      ) {
        await runtime.taskService.cleanup(taskId);
      }
    } catch {}
  }
  await runtime.processService
    .shutdownOwned({ graceMs: 500, killWaitMs: 100 })
    .catch(() => {});
  runtime.stateStore.close?.();
  await rm(root, { recursive: true, force: true });
}

function dataFrom(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

test("v0.4 secure durable output keeps live fidelity but redacts persisted command/env/stdout/stderr", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-redact-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });
  const secret = "TOKEN_CANARY_7f29a";
  const inlinePassword = "INLINE_PASSWORD_88";

  t.after(() => cleanupRuntime(runtime, [task.task_id], root));

  const started = await runtime.processService.start({
    taskId: task.task_id,
    shell:
      `printf '%s\\n' "$API_TOKEN"; printf 'password=${inlinePassword}\\n' >&2; # token=${secret}`,
    env: {
      API_TOKEN: secret,
      SAFE_VALUE: "visible",
    },
  });
  await waitForExit(runtime, task.task_id, started.process_id);

  const live = runtime.processService.output({
    taskId: task.task_id,
    processId: started.process_id,
    cursor: 0,
  });
  assert.match(live.stdout_chunk, new RegExp(secret));
  assert.match(live.stderr_chunk, new RegExp(inlinePassword));

  const persisted = runtime.stateStore.loadProcess(started.process_id);
  const durableText = JSON.stringify(persisted);
  assert.equal(durableText.includes(secret), false);
  assert.equal(durableText.includes(inlinePassword), false);
  assert.equal(durableText.includes("[REDACTED]"), true);
  assert.equal(persisted.env.API_TOKEN, "[REDACTED]");
  assert.equal(persisted.env.SAFE_VALUE, "visible");
  assert.equal(persisted.persisted_output_truncated, false);
  assert.ok(persisted.persisted_output_bytes <= 65536);
});

test("v0.4 secure durable argv redacts a separate secret-flag value", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-redact-argv-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const task = await runtime.taskService.create({ repoPath: repo });
  const secret = "ARGV_SECRET_CANARY_91";

  t.after(() => cleanupRuntime(runtime, [task.task_id], root));

  const started = await runtime.processService.start({
    taskId: task.task_id,
    argv: ["/usr/bin/printf", "%s %s\n", "--token", secret],
  });
  await waitForExit(runtime, task.task_id, started.process_id);

  const live = runtime.processService.output({
    taskId: task.task_id,
    processId: started.process_id,
    cursor: 0,
  });
  assert.match(live.stdout_chunk, new RegExp(secret));

  const persisted = runtime.stateStore.loadProcess(started.process_id);
  const durableText = JSON.stringify(persisted);
  assert.equal(durableText.includes(secret), false);
  assert.equal(persisted.argv.at(-1), "[REDACTED]");
  assert.equal(durableText.includes("[REDACTED]"), true);
});

test("v0.4 task hygiene exposes stale/blocker/worktree/storage state without deleting anything", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-hygiene-"));
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const runtime = makeRuntime(root, stateDir);
  const staleTask = await runtime.taskService.create({ repoPath: repo });
  const runningTask = await runtime.taskService.create({ repoPath: repo });
  const recentlyActiveTask = await runtime.taskService.create({ repoPath: repo });
  const finalizedTask = await runtime.taskService.create({ repoPath: repo });

  t.after(() =>
    cleanupRuntime(
      runtime,
      [
        staleTask.task_id,
        runningTask.task_id,
        recentlyActiveTask.task_id,
        finalizedTask.task_id,
      ],
      root,
    ),
  );

  await writeFile(
    path.join(staleTask.worktree_path, "hygiene-size.bin"),
    Buffer.alloc(8192, 7),
  );
  const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  runtime.taskService.mutate(staleTask.task_id, (task) => {
    task.approvals.push({
      approval_id: "approval_hygiene_test",
      status: "PENDING",
      created_at: oldTimestamp,
    });
    task.updated_at = oldTimestamp;
  });

  const running = await runtime.processService.start({
    taskId: runningTask.task_id,
    shell: "sleep 2",
  });

  const recent = await runtime.processService.start({
    taskId: recentlyActiveTask.task_id,
    shell: "true",
  });
  await waitForExit(runtime, recentlyActiveTask.task_id, recent.process_id);
  runtime.taskService.mutate(recentlyActiveTask.task_id, (task) => {
    task.updated_at = oldTimestamp;
  });

  runtime.taskService.cancel(finalizedTask.task_id);
  await runtime.taskService.cleanup(finalizedTask.task_id);

  const beforeStale = JSON.stringify(runtime.taskService.get(staleTask.task_id));
  const listing = await runtime.taskHygieneService.list({
    staleAfterSeconds: 60,
    includeFinalized: true,
  });
  const afterStale = JSON.stringify(runtime.taskService.get(staleTask.task_id));
  assert.equal(afterStale, beforeStale);

  const stale = listing.tasks.find((task) => task.task_id === staleTask.task_id);
  assert.equal(stale.status, "ACTIVE");
  assert.equal(stale.stale, true);
  assert.equal(stale.needs_attention, true);
  assert.equal(stale.pending_approval_count, 1);
  assert.equal(stale.blockers.some((blocker) => blocker.kind === "APPROVAL"), true);
  assert.equal(stale.worktree_present, true);
  assert.ok(stale.worktree_bytes >= 8192);

  const active = listing.tasks.find((task) => task.task_id === runningTask.task_id);
  assert.equal(active.active_run_count, 1);
  assert.equal(active.active_run_ids.includes(running.process_id), true);
  assert.equal(active.stale, false);

  const recentlyActive = listing.tasks.find(
    (task) => task.task_id === recentlyActiveTask.task_id,
  );
  assert.equal(recentlyActive.status, "ACTIVE");
  assert.equal(recentlyActive.active_run_count, 0);
  assert.equal(recentlyActive.stale, false);
  assert.ok(recentlyActive.last_activity_at);
  assert.ok(recentlyActive.last_activity_age_seconds < 60);

  const finalized = listing.tasks.find(
    (task) => task.task_id === finalizedTask.task_id,
  );
  assert.equal(finalized.status, "CANCELLED");
  assert.equal(finalized.workspace_cleaned, true);
  assert.equal(finalized.worktree_present, false);

  assert.ok(listing.storage.state_dir_bytes > 0);
  assert.ok(listing.storage.worktrees_dir_bytes > 0);
  assert.ok(listing.storage.non_worktree_state_bytes > 0);
  assert.equal(listing.storage.state_backend, "sqlite");
  assert.ok(listing.active_task_count >= 2);
  assert.ok(listing.stale_task_count >= 1);
  assert.ok(listing.uncleaned_task_count >= 2);

  const activeOnly = await runtime.taskHygieneService.list({
    staleAfterSeconds: 60,
    includeFinalized: false,
  });
  assert.equal(
    activeOnly.tasks.some((task) => task.task_id === finalizedTask.task_id),
    false,
  );

  runtime.processService.cancel({
    taskId: runningTask.task_id,
    processId: running.process_id,
  });
  await waitForExit(runtime, runningTask.task_id, running.process_id);
});

test("v0.4 MCP task.list is read-only and exposes hygiene/storage fields", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-hygiene-mcp-"));
  const repo = await makeRepo(root);
  const stateDir = path.join(root, "state");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-v04-hygiene-mcp", version: "0.4.0" },
    { capabilities: {} },
  );
  let task;

  t.after(async () => {
    try {
      if (task?.task_id) {
        await client.callTool({
          name: "task.cancel",
          arguments: { task_id: task.task_id },
        });
        await client.callTool({
          name: "task.cleanup",
          arguments: { task_id: task.task_id },
        });
      }
    } catch {}
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  const listTool = tools.tools.find((tool) => tool.name === "task.list");
  assert.ok(listTool);
  assert.equal(listTool.annotations?.readOnlyHint, true);
  assert.equal(listTool.annotations?.destructiveHint, false);

  task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const auditBefore = dataFrom(
    await client.callTool({
      name: "audit.get",
      arguments: { task_id: task.task_id, after_sequence: 0, limit: 100 },
    }),
  );

  const listing = dataFrom(
    await client.callTool({
      name: "task.list",
      arguments: {
        stale_after_seconds: 60,
        include_finalized: true,
      },
    }),
  );
  const auditAfter = dataFrom(
    await client.callTool({
      name: "audit.get",
      arguments: { task_id: task.task_id, after_sequence: 0, limit: 100 },
    }),
  );

  assert.equal(auditAfter.entries.length, auditBefore.entries.length);
  const found = listing.tasks.find((item) => item.task_id === task.task_id);
  assert.ok(found);
  assert.equal(typeof found.worktree_present, "boolean");
  assert.equal(typeof found.worktree_bytes, "number");
  assert.ok(Array.isArray(found.blockers));
  assert.equal(typeof listing.storage.state_dir_bytes, "number");
  assert.equal(typeof listing.storage.worktrees_dir_bytes, "number");
});

test("v0.4 sqlite v1 migration scrubs historical Process documents", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-redact-migrate-"));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "agentdock.db");
  const processId = "proc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secret = "MIGRATION_SECRET_CANARY_42";
  const raw = {
    process_id: processId,
    task_id: "task_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    pid: null,
    status: "EXITED",
    mode: "argv",
    argv: ["/usr/bin/printf", "%s\\n", "--token", secret],
    shell: `printf token=${secret}`,
    cwd: root,
    env: { API_TOKEN: "[REDACTED]" },
    started_at: new Date(Date.now() - 1000).toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: 0,
    signal: null,
    error: null,
    cancel_requested: false,
    output: [{ cursor: 0, stream: "stdout", text: `token=${secret}` }],
    output_floor_cursor: 0,
    next_output_cursor: 1,
    output_total_bytes: Buffer.byteLength(`token=${secret}`, "utf8"),
  };

  t.after(async () => rm(root, { recursive: true, force: true }));

  const db = new DatabaseSync(dbPath);
  db.exec(
    [
      "CREATE TABLE state_documents (",
      "  kind TEXT NOT NULL,",
      "  id TEXT NOT NULL,",
      "  value_json TEXT NOT NULL,",
      "  revision INTEGER NOT NULL DEFAULT 1,",
      "  updated_at TEXT NOT NULL,",
      "  PRIMARY KEY (kind, id)",
      ")",
    ].join("\n"),
  );
  db.prepare(
    "INSERT INTO state_documents(kind, id, value_json, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
  ).run("process", processId, JSON.stringify(raw), new Date().toISOString());
  db.exec("PRAGMA user_version=1");
  db.close();

  const store = new StateStore({ stateDir, backend: "sqlite" });
  const persisted = store.loadProcess(processId);
  assert.equal(JSON.stringify(persisted).includes(secret), false);
  assert.equal(persisted.argv.at(-1), "[REDACTED]");
  assert.equal(persisted.env.API_TOKEN, "[REDACTED]");
  assert.match(persisted.output[0].text, /\[REDACTED\]/);
  assert.equal(store.integrityCheck(), "ok");
  store.close();

  const verify = new DatabaseSync(dbPath);
  assert.equal(Number(verify.prepare("PRAGMA user_version").get().user_version), 2);
  verify.close();
});

test("v0.4 legacy JSON Process import is scrubbed while rollback material stays unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-redact-import-"));
  const stateDir = path.join(root, "state");
  const processesDir = path.join(stateDir, "processes");
  await mkdir(processesDir, { recursive: true });
  const processId = "proc_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const secret = "LEGACY_IMPORT_SECRET_77";
  const filePath = path.join(processesDir, processId + ".json");
  const raw = {
    process_id: processId,
    task_id: "task_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    pid: null,
    status: "EXITED",
    mode: "shell",
    argv: null,
    shell: `echo password=${secret}`,
    cwd: root,
    env: { PASSWORD: "[REDACTED]" },
    started_at: new Date(Date.now() - 1000).toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: 0,
    signal: null,
    error: null,
    cancel_requested: false,
    output: [{ cursor: 0, stream: "stdout", text: `password=${secret}` }],
    output_floor_cursor: 0,
    next_output_cursor: 1,
    output_total_bytes: Buffer.byteLength(`password=${secret}`, "utf8"),
  };
  const rawText = JSON.stringify(raw, null, 2) + "\n";
  await writeFile(filePath, rawText);

  t.after(async () => rm(root, { recursive: true, force: true }));

  const store = new StateStore({ stateDir, backend: "sqlite" });
  const persisted = store.loadProcess(processId);
  assert.equal(JSON.stringify(persisted).includes(secret), false);
  assert.equal(persisted.env.PASSWORD, "[REDACTED]");
  assert.match(persisted.output[0].text, /\[REDACTED\]/);
  assert.equal(await readFile(filePath, "utf8"), rawText);
  store.close();
});
