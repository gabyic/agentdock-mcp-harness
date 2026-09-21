import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
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
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text");
  return JSON.parse(text);
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition; last=" + JSON.stringify(last));
}

async function removeLinkedWorktrees(repoDir) {
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
    // Best-effort temp cleanup.
  }
}

test("Ticket 06: commit/finish and cancel/cleanup preserve lifecycle boundaries", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket06-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(path.join(repoDir, "test"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);

  await writeFile(
    path.join(repoDir, "app.js"),
    'export const answer = 41;\n',
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "test", "passing.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("passes", () => assert.equal(2 + 2, 4));\n',
    "utf8",
  );
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const sourceHeadBefore = await git(repoDir, ["rev-parse", "HEAD"]);
  const sourceStatusBefore = await git(repoDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({ AGENTDOCK_STATE_DIR: stateDir }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-ticket06-blackbox", version: "0.1.0" },
    { capabilities: {} },
  );

  t.after(async () => {
    try {
      await client.close();
    } catch {
      // Best-effort.
    }
    await removeLinkedWorktrees(repoDir);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    "git.commit",
    "task.finish",
    "task.cancel",
    "task.cleanup",
  ]) {
    assert.equal(toolNames.has(required), true, "missing MCP tool " + required);
  }

  // ---- Completion path --------------------------------------------------
  const completedTask = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  const appRead = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: {
        task_id: completedTask.task_id,
        path: "app.js",
      },
    }),
  );

  await client.callTool({
    name: "file.patch",
    arguments: {
      task_id: completedTask.task_id,
      path: "app.js",
      expected_sha256: appRead.sha256,
      old_text: "41",
      new_text: "42",
    },
  });

  const prematureFinish = await client.callTool({
    name: "task.finish",
    arguments: { task_id: completedTask.task_id },
  });
  assert.equal(prematureFinish.isError, true);
  assert.equal(
    dataFrom(prematureFinish).error.code,
    "TASK_UNCOMMITTED_CHANGES",
  );

  const passing = dataFrom(
    await client.callTool({
      name: "process.start",
      arguments: {
        task_id: completedTask.task_id,
        argv: [
          "/usr/bin/env",
          "-u",
          "NODE_TEST_CONTEXT",
          "-u",
          "NODE_TEST_WORKER_ID",
          process.execPath,
          "--test",
          "test/passing.test.js",
        ],
        cwd: ".",
      },
    }),
  );

  const passed = await waitFor(async () => {
    const status = dataFrom(
      await client.callTool({
        name: "process.status",
        arguments: {
          task_id: completedTask.task_id,
          process_id: passing.process_id,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });
  assert.equal(passed.exit_code, 0);

  const beforeCommit = dataFrom(
    await client.callTool({
      name: "git.diff",
      arguments: { task_id: completedTask.task_id },
    }),
  );
  assert.equal(
    beforeCommit.changed_files.some((entry) => entry.path === "app.js"),
    true,
  );

  const committed = dataFrom(
    await client.callTool({
      name: "git.commit",
      arguments: {
        task_id: completedTask.task_id,
        message: "fix: use the correct answer",
      },
    }),
  );
  assert.match(committed.commit_sha, /^[0-9a-f]{40}$/);
  assert.equal(committed.worktree_clean, true);
  assert.equal(
    await git(completedTask.worktree_path, ["rev-parse", "HEAD"]),
    committed.commit_sha,
  );

  const afterCommit = dataFrom(
    await client.callTool({
      name: "git.diff",
      arguments: { task_id: completedTask.task_id },
    }),
  );
  assert.deepEqual(afterCommit.changed_files, []);

  const finished = dataFrom(
    await client.callTool({
      name: "task.finish",
      arguments: { task_id: completedTask.task_id },
    }),
  );
  assert.equal(finished.status, "COMPLETED");
  assert.equal(finished.final_commit_sha, committed.commit_sha);
  assert.equal(finished.workspace_cleaned, false);
  await access(completedTask.worktree_path);

  const retainedRead = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: {
        task_id: completedTask.task_id,
        path: "app.js",
      },
    }),
  );
  assert.equal(retainedRead.content, 'export const answer = 42;\n');

  const writeAfterFinish = await client.callTool({
    name: "file.write",
    arguments: {
      task_id: completedTask.task_id,
      path: "after-finish.txt",
      content: "must not be written\n",
    },
  });
  assert.equal(writeAfterFinish.isError, true);
  assert.equal(dataFrom(writeAfterFinish).error.code, "TASK_NOT_ACTIVE");

  const processAfterFinish = await client.callTool({
    name: "process.start",
    arguments: {
      task_id: completedTask.task_id,
      shell: "printf should-not-run",
      cwd: ".",
    },
  });
  assert.equal(processAfterFinish.isError, true);
  assert.equal(dataFrom(processAfterFinish).error.code, "TASK_NOT_ACTIVE");

  // ---- Cancellation path ------------------------------------------------
  const cancelledTask = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  await client.callTool({
    name: "file.write",
    arguments: {
      task_id: cancelledTask.task_id,
      path: "cancel-note.txt",
      content: "preserve me until cleanup\n",
    },
  });

  const longProcess = dataFrom(
    await client.callTool({
      name: "process.start",
      arguments: {
        task_id: cancelledTask.task_id,
        shell: 'printf "running-before-cancel\\n"; sleep 30',
        cwd: ".",
      },
    }),
  );

  await waitFor(async () => {
    const output = dataFrom(
      await client.callTool({
        name: "process.output",
        arguments: {
          task_id: cancelledTask.task_id,
          process_id: longProcess.process_id,
          cursor: 0,
        },
      }),
    );
    return output.stdout_chunk.includes("running-before-cancel")
      ? output
      : null;
  });

  const cancelled = dataFrom(
    await client.callTool({
      name: "task.cancel",
      arguments: { task_id: cancelledTask.task_id },
    }),
  );
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.workspace_cleaned, false);
  assert.equal(cancelled.cancelled_processes.length, 1);
  assert.equal(cancelled.cancelled_processes[0].cancel_requested, true);

  const stopped = await waitFor(async () => {
    const status = dataFrom(
      await client.callTool({
        name: "process.status",
        arguments: {
          task_id: cancelledTask.task_id,
          process_id: longProcess.process_id,
        },
      }),
    );
    return status.status === "CANCELLED" ? status : null;
  });
  assert.equal(stopped.status, "CANCELLED");

  const cancelledRead = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: {
        task_id: cancelledTask.task_id,
        path: "cancel-note.txt",
      },
    }),
  );
  assert.equal(cancelledRead.content, "preserve me until cleanup\n");

  const cancelledDiff = dataFrom(
    await client.callTool({
      name: "git.diff",
      arguments: { task_id: cancelledTask.task_id },
    }),
  );
  assert.equal(
    cancelledDiff.changed_files.some(
      (entry) => entry.path === "cancel-note.txt",
    ),
    true,
  );

  const commitAfterCancel = await client.callTool({
    name: "git.commit",
    arguments: {
      task_id: cancelledTask.task_id,
      message: "should not commit",
    },
  });
  assert.equal(commitAfterCancel.isError, true);
  assert.equal(dataFrom(commitAfterCancel).error.code, "TASK_NOT_ACTIVE");

  const cancelledWorktree = cancelledTask.worktree_path;
  const cleaned = dataFrom(
    await client.callTool({
      name: "task.cleanup",
      arguments: { task_id: cancelledTask.task_id },
    }),
  );
  assert.equal(cleaned.status, "CANCELLED");
  assert.equal(cleaned.workspace_cleaned, true);
  assert.ok(cleaned.cleaned_at);

  await assert.rejects(access(cancelledWorktree), { code: "ENOENT" });

  const resumeAfterCleanup = await client.callTool({
    name: "task.resume",
    arguments: { task_id: cancelledTask.task_id },
  });
  assert.equal(resumeAfterCleanup.isError, true);
  assert.equal(
    dataFrom(resumeAfterCleanup).error.code,
    "TASK_WORKSPACE_CLEANED",
  );

  // Source repo is the immutable baseline for both Task paths.
  assert.equal(await git(repoDir, ["rev-parse", "HEAD"]), sourceHeadBefore);
  assert.equal(
    await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    sourceStatusBefore,
  );
  assert.equal(
    await readFile(path.join(repoDir, "app.js"), "utf8"),
    'export const answer = 41;\n',
  );
});
