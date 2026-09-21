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

const policyRules = [
  {
    id: "acceptance-smart-approval",
    effect: "ask",
    tool: "process.start",
    shell_regex: "^printf acceptance-approval",
    approval_scope: "acceptance-safe-operation",
  },
];

const AI_ENV_KEY =
  /(OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE.*AI|MISTRAL|GROQ|DEEPSEEK|OLLAMA|TOGETHER|COHERE)/i;

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}

function serverEnv(extra = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !AI_ENV_KEY.test(key),
    ),
  );
  return { ...inherited, ...extra };
}

function dataFrom(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text");
  return JSON.parse(text);
}

async function waitFor(check, { timeoutMs = 6000, intervalMs = 35 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    "Timed out waiting for condition; last=" + JSON.stringify(last),
  );
}

async function openClient(stateDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: serverEnv({
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_POLICY_JSON: JSON.stringify(policyRules),
    }),
    stderr: "pipe",
  });

  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client(
    { name: "agentdock-v01-acceptance-" + label, version: "0.1.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");

  return {
    client,
    transport,
    stderr: () => stderr,
  };
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
    // Best-effort temp cleanup.
  }
}

async function waitProcessExited(client, taskId, processId) {
  return waitFor(async () => {
    const status = dataFrom(
      await client.callTool({
        name: "process.status",
        arguments: {
          task_id: taskId,
          process_id: processId,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });
}

async function runProcessAndCollect(client, taskId, arguments_) {
  const processRecord = dataFrom(
    await client.callTool({
      name: "process.start",
      arguments: {
        task_id: taskId,
        ...arguments_,
      },
    }),
  );
  const status = await waitProcessExited(
    client,
    taskId,
    processRecord.process_id,
  );
  const output = dataFrom(
    await client.callTool({
      name: "process.output",
      arguments: {
        task_id: taskId,
        process_id: processRecord.process_id,
        cursor: 0,
      },
    }),
  );
  return { processRecord, status, output };
}

function approvalFrom(result) {
  assert.equal(result.isError, true);
  const payload = dataFrom(result);
  assert.equal(payload.error.code, "APPROVAL_REQUIRED");
  const request = payload.error.details?.approval_request;
  assert.ok(request);
  return request;
}

test("Ticket 08: AgentDock v0.1 automated MCP black-box acceptance", async (t) => {
  // Acceptance prerequisite: the server has no AI SDK/provider dependency.
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(packageJson.dependencies ?? {}).sort(),
    ["@modelcontextprotocol/server", "zod"],
  );
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@modelcontextprotocol/client"],
  );

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v01-acceptance-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(path.join(repoDir, "test"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Acceptance"]);
  await git(
    repoDir,
    ["config", "user.email", "agentdock-acceptance@example.invalid"],
  );

  // Stable two-part bug: first edit fixes subtotal, but the targeted test still
  // fails on currency formatting. The second edit is therefore driven by a
  // real failure result returned through AgentDock.
  await writeFile(
    path.join(repoDir, "src", "pricing.js"),
    [
      "export function subtotal(items) {",
      "  return items.reduce((sum, item) => sum + item.price, 1);",
      "}",
      "",
      "export function formatUsd(value) {",
      '  return "$" + value.toFixed(1);',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "test", "pricing.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { formatUsd, subtotal } from "../src/pricing.js";',
      "",
      'test("pricing target", () => {',
      "  assert.equal(subtotal([{ price: 2 }, { price: 3 }]), 5);",
      '  assert.equal(formatUsd(5), "$5.00");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "test", "regression.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { formatUsd } from "../src/pricing.js";',
      "",
      'test("currency regression", () => {',
      '  assert.equal(formatUsd(2.5), "$2.50");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "acceptance fixture"]);

  const sourceHeadBefore = await git(repoDir, ["rev-parse", "HEAD"]);
  const sourceStatusBefore = await git(repoDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const opened = [];
  t.after(async () => {
    for (const entry of opened.reverse()) {
      try {
        await entry.client.close();
      } catch {
        // Hard-restarted clients are expected to fail close.
      }
    }
    await removeLinkedWorktrees(repoDir);
    await rm(tempRoot, { recursive: true, force: true });
  });

  // From this task.create onward, every engineering action in the formal Task
  // is performed via AgentDock MCP. No SSH or direct fixture mutation is used.
  const first = await openClient(stateDir, "first");
  opened.push(first);

  const tools = await first.client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    "task.create",
    "task.resume",
    "file.read",
    "file.search",
    "file.patch",
    "process.start",
    "process.status",
    "process.output",
    "approval.respond",
    "git.diff",
    "git.commit",
    "task.finish",
    "audit.get",
  ]) {
    assert.equal(toolNames.has(required), true, "missing tool " + required);
  }

  const task = dataFrom(
    await first.client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );
  assert.notEqual(path.resolve(task.worktree_path), path.resolve(repoDir));
  assert.equal(task.base_head, sourceHeadBefore);
  assert.equal(
    await git(task.worktree_path, ["rev-parse", "HEAD"]),
    sourceHeadBefore,
  );

  const search = dataFrom(
    await first.client.callTool({
      name: "file.search",
      arguments: {
        task_id: task.task_id,
        query: "subtotal",
        path: "src",
        glob: "**/*.js",
      },
    }),
  );
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].path, "src/pricing.js");

  const firstRead = dataFrom(
    await first.client.callTool({
      name: "file.read",
      arguments: {
        task_id: task.task_id,
        path: "src/pricing.js",
      },
    }),
  );

  await first.client.callTool({
    name: "file.patch",
    arguments: {
      task_id: task.task_id,
      path: "src/pricing.js",
      expected_sha256: firstRead.sha256,
      old_text: "sum + item.price, 1",
      new_text: "sum + item.price, 0",
    },
  });

  const targetFail = await runProcessAndCollect(
    first.client,
    task.task_id,
    {
      argv: [
        "/usr/bin/env",
        "-u",
        "NODE_TEST_CONTEXT",
        "-u",
        "NODE_TEST_WORKER_ID",
        process.execPath,
        "--test",
        "test/pricing.test.js",
      ],
      cwd: ".",
    },
  );
  assert.equal(targetFail.status.exit_code, 1);
  assert.match(
    targetFail.output.stdout_chunk + targetFail.output.stderr_chunk,
    /pricing target|\$5\.0|\$5\.00|ERR_ASSERTION|not ok/i,
  );

  // Second modification is explicitly after observing the real failure.
  const secondRead = dataFrom(
    await first.client.callTool({
      name: "file.read",
      arguments: {
        task_id: task.task_id,
        path: "src/pricing.js",
      },
    }),
  );
  await first.client.callTool({
    name: "file.patch",
    arguments: {
      task_id: task.task_id,
      path: "src/pricing.js",
      expected_sha256: secondRead.sha256,
      old_text: "toFixed(1)",
      new_text: "toFixed(2)",
    },
  });

  const taskId = task.task_id;
  const worktreePath = task.worktree_path;

  // Graceful MCP disconnect, then reconnect through a fresh AgentDock instance.
  await first.client.close();
  const second = await openClient(stateDir, "second");
  opened.push(second);

  const reconnected = dataFrom(
    await second.client.callTool({
      name: "task.resume",
      arguments: { task_id: taskId },
    }),
  );
  assert.equal(reconnected.task_id, taskId);
  assert.equal(reconnected.worktree_path, worktreePath);

  const afterReconnect = dataFrom(
    await second.client.callTool({
      name: "file.read",
      arguments: {
        task_id: taskId,
        path: "src/pricing.js",
      },
    }),
  );
  assert.match(afterReconnect.content, /toFixed\(2\)/);

  // Hard restart AgentDock itself, then resume the same durable Task again.
  assert.ok(second.transport.pid);
  process.kill(second.transport.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const third = await openClient(stateDir, "third");
  opened.push(third);

  const restarted = dataFrom(
    await third.client.callTool({
      name: "task.resume",
      arguments: { task_id: taskId },
    }),
  );
  assert.equal(restarted.task_id, taskId);
  assert.equal(restarted.worktree_path, worktreePath);

  // Real Smart Approval round-trip, with ChatGPT represented by this MCP
  // reviewer response and no second model in AgentDock.
  const approvalAttempt = await third.client.callTool({
    name: "process.start",
    arguments: {
      task_id: taskId,
      shell: "printf acceptance-approval",
      cwd: ".",
    },
  });
  const approval = approvalFrom(approvalAttempt);
  assert.equal(approval.task_id, taskId);

  const approvalResponse = dataFrom(
    await third.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: taskId,
        approval_id: approval.approval_id,
        decision: "ALLOW_ONCE",
      },
    }),
  );
  assert.equal(approvalResponse.approval.status, "APPROVED");

  const approvedProcess = await runProcessAndCollect(
    third.client,
    taskId,
    {
      shell: "printf acceptance-approval",
      cwd: ".",
    },
  );
  assert.equal(approvedProcess.status.exit_code, 0);
  assert.match(approvedProcess.output.stdout_chunk, /acceptance-approval/);

  const targetPass = await runProcessAndCollect(
    third.client,
    taskId,
    {
      argv: [
        "/usr/bin/env",
        "-u",
        "NODE_TEST_CONTEXT",
        "-u",
        "NODE_TEST_WORKER_ID",
        process.execPath,
        "--test",
        "test/pricing.test.js",
      ],
      cwd: ".",
    },
  );
  assert.equal(targetPass.status.exit_code, 0);

  const fullPass = await runProcessAndCollect(
    third.client,
    taskId,
    {
      argv: [
        "/usr/bin/env",
        "-u",
        "NODE_TEST_CONTEXT",
        "-u",
        "NODE_TEST_WORKER_ID",
        process.execPath,
        "--test",
      ],
      cwd: ".",
    },
  );
  assert.equal(fullPass.status.exit_code, 0);
  assert.match(
    fullPass.output.stdout_chunk + fullPass.output.stderr_chunk,
    /pricing target|currency regression/i,
  );

  const diff = dataFrom(
    await third.client.callTool({
      name: "git.diff",
      arguments: { task_id: taskId },
    }),
  );
  assert.equal(
    diff.changed_files.some((entry) => entry.path === "src/pricing.js"),
    true,
  );
  assert.match(diff.patch, /sum \+ item\.price, 0/);
  assert.match(diff.patch, /toFixed\(2\)/);

  const commit = dataFrom(
    await third.client.callTool({
      name: "git.commit",
      arguments: {
        task_id: taskId,
        message: "fix: correct pricing calculations",
      },
    }),
  );
  assert.match(commit.commit_sha, /^[0-9a-f]{40}$/);
  assert.equal(
    await git(worktreePath, ["rev-parse", "HEAD"]),
    commit.commit_sha,
  );

  const finished = dataFrom(
    await third.client.callTool({
      name: "task.finish",
      arguments: { task_id: taskId },
    }),
  );
  assert.equal(finished.status, "COMPLETED");
  assert.equal(finished.final_commit_sha, commit.commit_sha);

  const audit = dataFrom(
    await third.client.callTool({
      name: "audit.get",
      arguments: { task_id: taskId, limit: 1000 },
    }),
  );
  const events = audit.entries.map((entry) => entry.event);

  assert.ok(events.filter((event) => event === "TASK_RESUMED").length >= 2);
  assert.ok(events.filter((event) => event === "FILE_PATCH").length >= 2);
  for (const requiredEvent of [
    "TASK_CREATED",
    "FILE_SEARCH",
    "FILE_READ",
    "PROCESS_STARTED",
    "PROCESS_ENDED",
    "APPROVAL_REQUESTED",
    "APPROVAL_RESPONDED",
    "GIT_COMMIT",
    "TASK_FINISHED",
  ]) {
    assert.equal(
      events.includes(requiredEvent),
      true,
      "missing audit event " + requiredEvent,
    );
  }
  assert.equal(
    audit.entries.some(
      (entry) =>
        entry.event === "GIT_COMMIT" &&
        entry.commit_sha === commit.commit_sha,
    ),
    true,
  );

  // Product-hypothesis invariants.
  assert.equal(await git(repoDir, ["rev-parse", "HEAD"]), sourceHeadBefore);
  assert.equal(
    await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    sourceStatusBefore,
  );
  assert.match(
    await readFile(path.join(repoDir, "src", "pricing.js"), "utf8"),
    /sum \+ item\.price, 1/,
  );
  assert.match(
    await readFile(path.join(repoDir, "src", "pricing.js"), "utf8"),
    /toFixed\(1\)/,
  );
});
