import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
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

test("Ticket 03: async process lifecycle supports cursor output, cancel, argv and shell", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket03-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(path.join(repoDir, "subdir"), { recursive: true });
  await mkdir(path.join(repoDir, "test"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);

  await writeFile(
    path.join(repoDir, "test", "failing.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("intentional failure", () => assert.equal(1, 2));\n',
    "utf8",
  );
  await writeFile(path.join(repoDir, "subdir", "marker.txt"), "marker\n", "utf8");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({ AGENTDOCK_STATE_DIR: stateDir }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-ticket03-blackbox", version: "0.1.0" },
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
    "process.start",
    "process.status",
    "process.output",
    "process.cancel",
  ]) {
    assert.equal(toolNames.has(required), true, "missing MCP tool " + required);
  }

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  const longProcess = dataFrom(
    await client.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        shell:
          'printf "first:%s:%s\\n" "$TICKET03_VALUE" "$PWD"; sleep 1.2; printf "second\\n"; sleep 30',
        cwd: "subdir",
        env: { TICKET03_VALUE: "visible" },
      },
    }),
  );

  assert.match(longProcess.process_id, /^proc_[0-9a-f-]{36}$/);
  assert.equal(longProcess.task_id, task.task_id);
  assert.equal(longProcess.status, "RUNNING");
  assert.equal(longProcess.mode, "shell");
  assert.equal(longProcess.env.TICKET03_VALUE, "visible");
  assert.match(longProcess.cwd, /subdir$/);

  const firstOutput = await waitFor(async () => {
    const output = dataFrom(
      await client.callTool({
        name: "process.output",
        arguments: {
          task_id: task.task_id,
          process_id: longProcess.process_id,
          cursor: 0,
        },
      }),
    );
    return output.stdout_chunk.includes("first:visible:") ? output : null;
  });

  assert.equal(firstOutput.stderr_chunk, "");
  assert.ok(firstOutput.next_cursor > 0);
  const firstCursor = firstOutput.next_cursor;

  const secondOutput = await waitFor(async () => {
    const output = dataFrom(
      await client.callTool({
        name: "process.output",
        arguments: {
          task_id: task.task_id,
          process_id: longProcess.process_id,
          cursor: firstCursor,
        },
      }),
    );
    return output.stdout_chunk.includes("second") ? output : null;
  }, { timeoutMs: 4000 });

  assert.equal(secondOutput.stdout_chunk.includes("first:visible:"), false);
  assert.ok(secondOutput.next_cursor > firstCursor);

  const cancelResult = dataFrom(
    await client.callTool({
      name: "process.cancel",
      arguments: {
        task_id: task.task_id,
        process_id: longProcess.process_id,
      },
    }),
  );
  assert.equal(cancelResult.cancel_requested, true);

  const cancelled = await waitFor(async () => {
    const status = dataFrom(
      await client.callTool({
        name: "process.status",
        arguments: {
          task_id: task.task_id,
          process_id: longProcess.process_id,
        },
      }),
    );
    return status.status === "CANCELLED" ? status : null;
  });
  assert.equal(cancelled.status, "CANCELLED");

  const failing = dataFrom(
    await client.callTool({
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
        env: { TICKET03_ARGV_MODE: "1" },
      },
    }),
  );
  assert.equal(failing.mode, "argv");
  assert.deepEqual(
    failing.argv,
    [
      "/usr/bin/env",
      "-u",
      "NODE_TEST_CONTEXT",
      "-u",
      "NODE_TEST_WORKER_ID",
      process.execPath,
      "--test",
      "test/failing.test.js",
    ],
  );

  const failedStatus = await waitFor(async () => {
    const status = dataFrom(
      await client.callTool({
        name: "process.status",
        arguments: {
          task_id: task.task_id,
          process_id: failing.process_id,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });
  const failureOutput = dataFrom(
    await client.callTool({
      name: "process.output",
      arguments: {
        task_id: task.task_id,
        process_id: failing.process_id,
        cursor: 0,
      },
    }),
  );
  assert.equal(
    failedStatus.exit_code,
    1,
    JSON.stringify({ failedStatus, failureOutput }),
  );

  assert.equal(failureOutput.exit_code, 1);
  assert.match(
    failureOutput.stdout_chunk + failureOutput.stderr_chunk,
    /intentional failure|ERR_ASSERTION|not ok/i,
  );
});
