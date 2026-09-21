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
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text");
  return JSON.parse(text);
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 40 } = {}) {
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

async function openClient(stateDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({ AGENTDOCK_STATE_DIR: stateDir }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-ticket04-" + label, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
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

test("Ticket 04: Task and process diagnostics survive reconnect and AgentDock restart", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket04-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(path.join(repoDir, "test"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);

  await writeFile(
    path.join(repoDir, "app.js"),
    'export const message = "before";\n',
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "test", "failing.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("durable failure", () => assert.equal("before", "after"));\n',
    "utf8",
  );
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const openedClients = [];
  t.after(async () => {
    for (const entry of openedClients.reverse()) {
      try {
        await entry.client.close();
      } catch {
        // Best-effort.
      }
    }
    await removeLinkedWorktrees(repoDir);
    await rm(tempRoot, { recursive: true, force: true });
  });

  const first = await openClient(stateDir, "first");
  openedClients.push(first);

  const task = dataFrom(
    await first.client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  const read = dataFrom(
    await first.client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "app.js" },
    }),
  );
  await first.client.callTool({
    name: "file.patch",
    arguments: {
      task_id: task.task_id,
      path: "app.js",
      expected_sha256: read.sha256,
      old_text: '"before"',
      new_text: '"after"',
    },
  });

  const failing = dataFrom(
    await first.client.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        argv: [
          "/usr/bin/env",
          "-u",
          "NODE_TEST_CONTEXT",
          "-u",
          "NODE_TEST_WORKER_ID",
          process.execPath,
          "--test",
          "test/failing.test.js",
        ],
        cwd: ".",
      },
    }),
  );

  const failed = await waitFor(async () => {
    const status = dataFrom(
      await first.client.callTool({
        name: "process.status",
        arguments: {
          task_id: task.task_id,
          process_id: failing.process_id,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });
  assert.equal(failed.exit_code, 1);

  const failedOutputBefore = dataFrom(
    await first.client.callTool({
      name: "process.output",
      arguments: {
        task_id: task.task_id,
        process_id: failing.process_id,
        cursor: 0,
      },
    }),
  );
  assert.match(
    failedOutputBefore.stdout_chunk + failedOutputBefore.stderr_chunk,
    /durable failure|ERR_ASSERTION|not ok/i,
  );

  const originalWorktree = task.worktree_path;
  const originalTaskId = task.task_id;

  // Closing the stdio MCP client also ends this AgentDock server process.
  // Starting a fresh client below therefore exercises the stricter form of
  // MCP reconnect: a brand-new AgentDock process with the same durable state.
  await first.client.close();

  const second = await openClient(stateDir, "second");
  openedClients.push(second);

  const resumed = dataFrom(
    await second.client.callTool({
      name: "task.resume",
      arguments: { task_id: originalTaskId },
    }),
  );

  assert.equal(resumed.task_id, originalTaskId);
  assert.equal(resumed.worktree_path, originalWorktree);
  assert.equal(resumed.status, "ACTIVE");
  assert.equal(resumed.processes.length, 1);
  assert.equal(resumed.processes[0].process_id, failing.process_id);
  assert.equal(resumed.processes[0].status, "EXITED");
  assert.equal(resumed.processes[0].exit_code, 1);

  const persistedFile = dataFrom(
    await second.client.callTool({
      name: "file.read",
      arguments: { task_id: originalTaskId, path: "app.js" },
    }),
  );
  assert.equal(persistedFile.content, 'export const message = "after";\n');

  const failedOutputAfter = dataFrom(
    await second.client.callTool({
      name: "process.output",
      arguments: {
        task_id: originalTaskId,
        process_id: failing.process_id,
        cursor: 0,
      },
    }),
  );
  assert.equal(failedOutputAfter.exit_code, 1);
  assert.equal(
    failedOutputAfter.stdout_chunk + failedOutputAfter.stderr_chunk,
    failedOutputBefore.stdout_chunk + failedOutputBefore.stderr_chunk,
  );

  // Create a genuinely running process, persist at least one output chunk,
  // then terminate AgentDock by closing the MCP transport. The next instance
  // must never claim it still owns that process.
  const running = dataFrom(
    await second.client.callTool({
      name: "process.start",
      arguments: {
        task_id: originalTaskId,
        shell: 'printf "before-restart\\n"; sleep 2',
        cwd: ".",
      },
    }),
  );

  await waitFor(async () => {
    const output = dataFrom(
      await second.client.callTool({
        name: "process.output",
        arguments: {
          task_id: originalTaskId,
          process_id: running.process_id,
          cursor: 0,
        },
      }),
    );
    return output.stdout_chunk.includes("before-restart") ? output : null;
  });

  assert.ok(second.transport.pid, "AgentDock stdio server PID should be available");
  process.kill(second.transport.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const third = await openClient(stateDir, "third");
  openedClients.push(third);

  const resumedAgain = dataFrom(
    await third.client.callTool({
      name: "task.resume",
      arguments: { task_id: originalTaskId },
    }),
  );

  const restoredRunning = resumedAgain.processes.find(
    (entry) => entry.process_id === running.process_id,
  );
  assert.ok(restoredRunning);
  assert.equal(restoredRunning.status, "INTERRUPTED");
  assert.match(restoredRunning.error, /restarted|lost ownership/i);

  const interruptedOutput = dataFrom(
    await third.client.callTool({
      name: "process.output",
      arguments: {
        task_id: originalTaskId,
        process_id: running.process_id,
        cursor: 0,
      },
    }),
  );
  assert.equal(interruptedOutput.status, "INTERRUPTED");
  assert.match(interruptedOutput.stdout_chunk, /before-restart/);

  const invalidTask = await third.client.callTool({
    name: "task.resume",
    arguments: { task_id: "../../etc/passwd" },
  });
  assert.equal(invalidTask.isError, true);
  assert.equal(dataFrom(invalidTask).error.code, "INVALID_TASK_ID");

  const invalidProcess = await third.client.callTool({
    name: "process.status",
    arguments: {
      task_id: originalTaskId,
      process_id: "../../process.json",
    },
  });
  assert.equal(invalidProcess.isError, true);
  assert.equal(dataFrom(invalidProcess).error.code, "INVALID_PROCESS_ID");

  const completedAgain = dataFrom(
    await third.client.callTool({
      name: "process.status",
      arguments: {
        task_id: originalTaskId,
        process_id: failing.process_id,
      },
    }),
  );
  assert.equal(completedAgain.status, "EXITED");
  assert.equal(completedAgain.exit_code, 1);

  assert.equal(
    await readFile(path.join(originalWorktree, "app.js"), "utf8"),
    'export const message = "after";\n',
  );
});
