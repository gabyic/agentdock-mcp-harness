import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}

function cleanEnv(extra = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    ...extra,
  };
}

function dataFrom(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text");
  return JSON.parse(text);
}

async function removeLinkedWorktrees(repoDir) {
  try {
    const worktrees = await git(repoDir, ["worktree", "list", "--porcelain"]);
    for (const block of worktrees.split("\n\n")) {
      const line = block
        .split("\n")
        .find((entry) => entry.startsWith("worktree "));
      const worktree = line?.slice("worktree ".length);
      if (worktree && path.resolve(worktree) !== path.resolve(repoDir)) {
        await git(repoDir, ["worktree", "remove", "--force", worktree]);
      }
    }
  } catch {
    // Best effort temp cleanup.
  }
}

test("v0.4 MCP minimal Plan runs independently and task.resume exposes durable progress", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-plan-mcp-"));
  const repoDir = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repoDir, "README.md"), "Plan MCP\n");
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-m", "fixture"]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-v04-plan-mcp", version: "0.1.0" },
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
    try {
      await client.close();
    } catch {}
    await removeLinkedWorktrees(repoDir);
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  const planRequest = {
    task_id: task.task_id,
    idempotency_key: "mcp-verification-plan",
    steps: [
      {
        step_id: "slow",
        shell: "sleep 0.35; printf 'slow\\n' >> verify.log",
      },
      {
        step_id: "fast",
        shell: "printf 'fast\\n' >> verify.log",
      },
    ],
  };

  const startedAt = Date.now();
  const started = dataFrom(
    await client.callTool({
      name: "plan.start",
      arguments: planRequest,
    }),
  );
  assert.equal(started.status, "RUNNING");
  assert.equal(started.idempotent_replay, false);
  assert.ok(Date.now() - startedAt < 250);

  const replay = dataFrom(
    await client.callTool({
      name: "plan.start",
      arguments: planRequest,
    }),
  );
  assert.equal(replay.plan_id, started.plan_id);
  assert.equal(replay.idempotent_replay, true);

  const resumedWhileRunning = dataFrom(
    await client.callTool({
      name: "task.resume",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(resumedWhileRunning.latest_plan.plan_id, started.plan_id);
  assert.equal(resumedWhileRunning.latest_plan.status, "RUNNING");
  assert.equal(resumedWhileRunning.activity_state, "VERIFYING");
  assert.equal(resumedWhileRunning.recommended_next_action, "WAIT_FOR_PLAN");

  let current = started;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    current = dataFrom(
      await client.callTool({
        name: "plan.get",
        arguments: {
          task_id: task.task_id,
          plan_id: started.plan_id,
          after_revision: current.revision,
          wait_ms: 1000,
        },
      }),
    );
    if (current.status !== "RUNNING") break;
  }

  assert.equal(current.status, "READY_TO_COMMIT");
  assert.equal(current.last_successful_step_id, "fast");

  const resumedAfter = dataFrom(
    await client.callTool({
      name: "task.resume",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(resumedAfter.latest_plan.status, "READY_TO_COMMIT");
  assert.equal(resumedAfter.activity_state, "READY_TO_COMMIT");
  assert.equal(resumedAfter.recommended_next_action, "COMMIT_REQUIRED");

  const effect = await readFile(
    path.join(task.worktree_path, "verify.log"),
    "utf8",
  );
  assert.deepEqual(effect.trim().split(/\n/), ["slow", "fast"]);
});
