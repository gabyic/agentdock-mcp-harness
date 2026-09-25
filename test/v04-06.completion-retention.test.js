import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentDock Test",
      GIT_AUTHOR_EMAIL: "agentdock@example.invalid",
      GIT_COMMITTER_NAME: "AgentDock Test",
      GIT_COMMITTER_EMAIL: "agentdock@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trimEnd();
}

function dataFrom(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP result should contain JSON text");
  return JSON.parse(text);
}

async function clientFor(stateDir) {
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
    { name: "completion-retention-test", version: "0.4.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function makeRepo(root, file = "app.txt", text = "before\n") {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, file), text);
  await git(repo, ["add", file]);
  await git(repo, ["commit", "-m", "base"]);
  return repo;
}

test("v0.4 completion retention: COMMIT survives cleanup, reflog expiry, and aggressive GC", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-retain-"));
  const repo = await makeRepo(root);
  const state = path.join(root, "state");
  const client = await clientFor(state);

  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const read = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "app.txt" },
    }),
  );
  await client.callTool({
    name: "file.patch",
    arguments: {
      task_id: task.task_id,
      path: "app.txt",
      expected_sha256: read.sha256,
      old_text: "before",
      new_text: "after",
    },
  });
  const committed = dataFrom(
    await client.callTool({
      name: "git.commit",
      arguments: { task_id: task.task_id, message: "change app" },
    }),
  );
  const finished = dataFrom(
    await client.callTool({
      name: "task.finish",
      arguments: { task_id: task.task_id },
    }),
  );

  assert.equal(finished.outcome, "COMMIT");
  assert.equal(finished.outcome_reason, null);
  assert.equal(finished.final_commit_sha, committed.commit_sha);
  assert.equal(
    finished.retention_ref,
    "refs/agentdock/tasks/" + task.task_id,
  );
  assert.equal(
    await git(repo, ["rev-parse", "--verify", finished.retention_ref + "^{commit}"]),
    committed.commit_sha,
  );

  const cleaned = dataFrom(
    await client.callTool({
      name: "task.cleanup",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(cleaned.workspace_cleaned, true);

  await git(repo, ["reflog", "expire", "--expire=now", "--all"]);
  await git(repo, ["gc", "--prune=now"]);

  assert.equal(
    await git(repo, ["rev-parse", "--verify", finished.retention_ref + "^{commit}"]),
    committed.commit_sha,
  );
  assert.equal(await git(repo, ["cat-file", "-t", committed.commit_sha]), "commit");
});

test("v0.4 completion retention: clean Task requires explicit NO_CHANGE evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-nochange-"));
  const repo = await makeRepo(root, "README.md", "# base\n");
  const state = path.join(root, "state");
  const client = await clientFor(state);

  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );

  const accidental = await client.callTool({
    name: "task.finish",
    arguments: { task_id: task.task_id },
  });
  assert.equal(accidental.isError, true);
  assert.equal(dataFrom(accidental).error.code, "TASK_OUTCOME_REQUIRED");

  const missingReason = await client.callTool({
    name: "task.finish",
    arguments: { task_id: task.task_id, outcome: "NO_CHANGE" },
  });
  assert.equal(missingReason.isError, true);
  assert.equal(
    dataFrom(missingReason).error.code,
    "TASK_NO_CHANGE_REASON_REQUIRED",
  );

  const finished = dataFrom(
    await client.callTool({
      name: "task.finish",
      arguments: {
        task_id: task.task_id,
        outcome: "NO_CHANGE",
        reason: "Investigation confirmed the repository already satisfies the requested behavior.",
      },
    }),
  );

  assert.equal(finished.status, "COMPLETED");
  assert.equal(finished.outcome, "NO_CHANGE");
  assert.match(finished.outcome_reason, /already satisfies/);
  assert.equal(finished.retention_ref, null);
  assert.equal(finished.final_commit_sha, task.base_head);

  const cleaned = dataFrom(
    await client.callTool({
      name: "task.cleanup",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(cleaned.workspace_cleaned, true);
});

test("v0.4 completion retention: outcome cannot contradict Git history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-outcome-"));
  const repo = await makeRepo(root);
  const state = path.join(root, "state");
  const client = await clientFor(state);

  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const cleanTask = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const fakeCommit = await client.callTool({
    name: "task.finish",
    arguments: { task_id: cleanTask.task_id, outcome: "COMMIT" },
  });
  assert.equal(fakeCommit.isError, true);
  assert.equal(dataFrom(fakeCommit).error.code, "TASK_COMMIT_REQUIRED");

  await client.callTool({
    name: "task.cancel",
    arguments: { task_id: cleanTask.task_id },
  });
  await client.callTool({
    name: "task.cleanup",
    arguments: { task_id: cleanTask.task_id },
  });

  const changedTask = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const read = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: changedTask.task_id, path: "app.txt" },
    }),
  );
  await client.callTool({
    name: "file.patch",
    arguments: {
      task_id: changedTask.task_id,
      path: "app.txt",
      expected_sha256: read.sha256,
      old_text: "before",
      new_text: "after",
    },
  });
  await client.callTool({
    name: "git.commit",
    arguments: { task_id: changedTask.task_id, message: "change app" },
  });

  const hiddenCommit = await client.callTool({
    name: "task.finish",
    arguments: {
      task_id: changedTask.task_id,
      outcome: "NO_CHANGE",
      reason: "Should not be accepted.",
    },
  });
  assert.equal(hiddenCommit.isError, true);
  assert.equal(dataFrom(hiddenCommit).error.code, "TASK_NO_CHANGE_HAS_COMMIT");

  await client.callTool({
    name: "task.cancel",
    arguments: { task_id: changedTask.task_id },
  });
  await client.callTool({
    name: "task.cleanup",
    arguments: { task_id: changedTask.task_id },
  });
});

test("v0.4 completion retention: cleanup refuses a missing or moved retention ref", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-retain-guard-"));
  const repo = await makeRepo(root);
  const state = path.join(root, "state");
  const client = await clientFor(state);

  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const read = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "app.txt" },
    }),
  );
  await client.callTool({
    name: "file.patch",
    arguments: {
      task_id: task.task_id,
      path: "app.txt",
      expected_sha256: read.sha256,
      old_text: "before",
      new_text: "after",
    },
  });
  await client.callTool({
    name: "git.commit",
    arguments: { task_id: task.task_id, message: "change app" },
  });
  const finished = dataFrom(
    await client.callTool({
      name: "task.finish",
      arguments: { task_id: task.task_id },
    }),
  );

  await git(repo, ["update-ref", "-d", finished.retention_ref]);

  const refused = await client.callTool({
    name: "task.cleanup",
    arguments: { task_id: task.task_id },
  });
  assert.equal(refused.isError, true);
  assert.equal(dataFrom(refused).error.code, "TASK_COMMIT_NOT_RETAINED");

  await access(task.worktree_path);
});

test("v0.4 completion retention: legacy completed commit without retention is fail-closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-legacy-retain-"));
  const repo = await makeRepo(root);
  const stateDir = path.join(root, "state");
  const { config } = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
    },
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });

  t.after(async () => {
    await runtime.processService
      .shutdownOwned({ graceMs: 0, killWaitMs: 0 })
      .catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(path.join(task.worktree_path, "legacy.txt"), "legacy\n");
  await git(task.worktree_path, ["add", "-A"]);
  await git(task.worktree_path, ["commit", "-m", "legacy task result"]);
  const finalCommit = await git(task.worktree_path, ["rev-parse", "HEAD"]);

  runtime.stateStore.mutateTask(task.task_id, (current) => {
    current.status = "COMPLETED";
    current.final_commit_sha = finalCommit;
    current.finished_at = new Date().toISOString();
    current.outcome = null;
    current.retention_ref = null;
    return current;
  });

  await assert.rejects(
    () => runtime.taskService.cleanup(task.task_id),
    (error) => error?.code === "TASK_COMMIT_NOT_RETAINED",
  );
  await access(task.worktree_path);
});

test("v0.4 completion retention: cancelled Task cleanup remains compatible", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-cancel-cleanup-"));
  const repo = await makeRepo(root);
  const state = path.join(root, "state");
  const client = await clientFor(state);

  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const cancelled = dataFrom(
    await client.callTool({
      name: "task.cancel",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(cancelled.status, "CANCELLED");

  const cleaned = dataFrom(
    await client.callTool({
      name: "task.cleanup",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(cleaned.workspace_cleaned, true);
});
