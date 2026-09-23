import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);

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
  assert.ok(text);
  return JSON.parse(text);
}

async function clientFor(stateDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: { ...process.env, AGENTDOCK_STATE_DIR: stateDir },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "task-durability-test", version: "0.4.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

test("v0.4: completed Task commit stays reachable after cleanup and aggressive Git GC", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-retain-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "app.txt"), "before\n");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "base"]);

  const client = await clientFor(state);
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const task = dataFrom(await client.callTool({
    name: "task.create",
    arguments: { repo_path: repo },
  }));
  const read = dataFrom(await client.callTool({
    name: "file.read",
    arguments: { task_id: task.task_id, path: "app.txt" },
  }));
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
  const committed = dataFrom(await client.callTool({
    name: "git.commit",
    arguments: { task_id: task.task_id, message: "change app" },
  }));
  const finished = dataFrom(await client.callTool({
    name: "task.finish",
    arguments: { task_id: task.task_id },
  }));

  assert.equal(finished.outcome, "COMMIT");
  assert.equal(finished.final_commit_sha, committed.commit_sha);
  assert.equal(
    finished.retention_ref,
    "refs/agentdock/tasks/" + task.task_id,
  );
  assert.equal(
    await git(repo, ["rev-parse", finished.retention_ref]),
    committed.commit_sha,
  );

  await client.callTool({
    name: "task.cleanup",
    arguments: { task_id: task.task_id },
  });

  await git(repo, ["reflog", "expire", "--expire=now", "--all"]);
  await git(repo, ["gc", "--prune=now"]);
  assert.equal(
    await git(repo, ["rev-parse", finished.retention_ref]),
    committed.commit_sha,
  );
  assert.equal(
    await git(repo, ["cat-file", "-t", committed.commit_sha]),
    "commit",
  );
});

test("v0.4: clean untouched Task requires explicit NO_CHANGE evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-nochange-"));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "# base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "base"]);

  const client = await clientFor(state);
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const task = dataFrom(await client.callTool({
    name: "task.create",
    arguments: { repo_path: repo },
  }));

  const accidental = await client.callTool({
    name: "task.finish",
    arguments: { task_id: task.task_id },
  });
  assert.equal(accidental.isError, true);
  assert.equal(dataFrom(accidental).error.code, "TASK_OUTCOME_REQUIRED");

  const noChange = dataFrom(await client.callTool({
    name: "task.finish",
    arguments: {
      task_id: task.task_id,
      outcome: "NO_CHANGE",
      reason: "Investigation confirmed the repository already satisfies the requested behavior.",
    },
  }));
  assert.equal(noChange.status, "COMPLETED");
  assert.equal(noChange.outcome, "NO_CHANGE");
  assert.match(noChange.outcome_reason, /already satisfies/);
  assert.equal(noChange.retention_ref, null);
});
