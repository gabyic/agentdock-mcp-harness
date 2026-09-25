import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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

test("v0.4 MCP run.start consumes idempotency_key end to end", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-idem-mcp-"));
  const repoDir = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repoDir, "README.md"), "MCP idempotency\n");
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
    { name: "agentdock-v04-idem-mcp", version: "0.1.0" },
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
    } catch {
      // Best effort temp cleanup.
    }
    try {
      await client.close();
    } catch {
      // Best effort.
    }
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

  const request = {
    task_id: task.task_id,
    shell: "printf 'mcp-effect\\n' >> mcp-effect.log; sleep 0.2",
    idempotency_key: "mcp-same-run",
  };

  const first = dataFrom(
    await client.callTool({
      name: "run.start",
      arguments: request,
    }),
  );
  assert.equal(first.idempotent_replay, false);

  const replay = dataFrom(
    await client.callTool({
      name: "run.start",
      arguments: request,
    }),
  );
  assert.equal(replay.run_id, first.run_id);
  assert.equal(replay.idempotent_replay, true);

  let cursor = 0;
  let terminal;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    terminal = dataFrom(
      await client.callTool({
        name: "run.get",
        arguments: {
          task_id: task.task_id,
          run_id: first.run_id,
          cursor,
          wait_ms: 1000,
          max_bytes: 16384,
          max_chunks: 4,
        },
      }),
    );
    cursor = terminal.next_cursor;
    if (
      ["EXITED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(
        terminal.status,
      ) &&
      !terminal.has_more
    ) {
      break;
    }
  }

  assert.equal(terminal.status, "EXITED");
  assert.equal(terminal.exit_code, 0);

  const effect = await readFile(
    path.join(task.worktree_path, "mcp-effect.log"),
    "utf8",
  );
  assert.deepEqual(effect.trim().split(/\n/), ["mcp-effect"]);
});
