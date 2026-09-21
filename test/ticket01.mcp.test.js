import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text");
  return JSON.parse(text);
}

test("Ticket 01: dirty repo creates unique clean isolated Task worktrees through MCP", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket01-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);

  await writeFile(path.join(repoDir, "app.txt"), "committed\n", "utf8");
  await git(repoDir, ["add", "app.txt"]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const headBefore = await git(repoDir, ["rev-parse", "HEAD"]);

  // Make the source working tree intentionally dirty. Task worktrees must not
  // inherit either the tracked modification or the untracked file.
  await writeFile(path.join(repoDir, "app.txt"), "dirty source change\n", "utf8");
  await writeFile(path.join(repoDir, "source-only.txt"), "untracked\n", "utf8");
  const statusBefore = await git(repoDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  assert.notEqual(statusBefore, "");

  let serverStderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({ AGENTDOCK_STATE_DIR: stateDir }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    serverStderr += chunk.toString();
  });

  const client = new Client(
    { name: "agentdock-ticket01-blackbox", version: "0.1.0" },
    { capabilities: {} },
  );

  t.after(async () => {
    try {
      await client.close();
    } catch {
      // Best-effort test cleanup.
    }

    // Remove worktrees before deleting the temp repo so Git metadata is left
    // consistent during the test itself.
    try {
      const worktrees = await git(repoDir, ["worktree", "list", "--porcelain"]);
      for (const block of worktrees.split("\n\n")) {
        const line = block.split("\n").find((entry) => entry.startsWith("worktree "));
        const worktree = line?.slice("worktree ".length);
        if (worktree && path.resolve(worktree) !== path.resolve(repoDir)) {
          await git(repoDir, ["worktree", "remove", "--force", worktree]);
        }
      }
    } catch {
      // Temp tree removal below is sufficient if Git cleanup itself fails.
    }

    await rm(tempRoot, { recursive: true, force: true });
  });

  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("repo.inspect"), `tools: ${toolNames.join(", ")}`);
  assert.ok(toolNames.includes("task.create"), `tools: ${toolNames.join(", ")}`);

  const inspected = dataFrom(
    await client.callTool({
      name: "repo.inspect",
      arguments: { path: repoDir },
    }),
  );

  assert.equal(inspected.repo_root, await realpath(repoDir));
  assert.equal(inspected.head, headBefore);
  assert.equal(inspected.source_dirty, true);
  assert.ok(
    inspected.status_porcelain.some((entry) => entry.includes("app.txt")),
  );
  assert.ok(
    inspected.status_porcelain.some((entry) => entry.includes("source-only.txt")),
  );

  const task1 = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );
  const task2 = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  assert.match(task1.task_id, /^task_[0-9a-f-]{36}$/);
  assert.match(task2.task_id, /^task_[0-9a-f-]{36}$/);
  assert.notEqual(task1.task_id, task2.task_id);
  assert.equal(task1.status, "ACTIVE");
  assert.equal(task1.base_head, headBefore);
  assert.equal(task1.source_dirty, true);
  assert.equal(task1.uncommitted_changes_not_included, true);
  assert.equal(task1.worktree_clean, true);

  for (const task of [task1, task2]) {
    assert.equal(await git(task.worktree_path, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(
      await git(task.worktree_path, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      "",
    );
    assert.equal(
      await readFile(path.join(task.worktree_path, "app.txt"), "utf8"),
      "committed\n",
    );
    await assert.rejects(
      readFile(path.join(task.worktree_path, "source-only.txt"), "utf8"),
      { code: "ENOENT" },
    );
  }

  assert.equal(await git(repoDir, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(
    await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    statusBefore,
    `source repo changed unexpectedly; server stderr: ${serverStderr}`,
  );
});
