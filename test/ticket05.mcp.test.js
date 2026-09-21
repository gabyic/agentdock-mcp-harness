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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const policyRules = [
  {
    id: "explicit-allow",
    effect: "allow",
    tool: "process.start",
    shell_regex: "^printf explicit-allow",
  },
  {
    id: "explicit-deny",
    effect: "deny",
    tool: "process.start",
    shell_regex: "^printf explicit-deny",
  },
  {
    id: "task-approval",
    effect: "ask",
    tool: "process.start",
    shell_regex: "^printf task-approved-",
    approval_scope: "safe-task-processes",
  },
  {
    id: "once-approval",
    effect: "ask",
    tool: "process.start",
    shell_regex: "^printf once-only",
  },
  {
    id: "review-deny",
    effect: "ask",
    tool: "process.start",
    shell_regex: "^printf review-deny",
  },
  {
    id: "review-user",
    effect: "ask",
    tool: "process.start",
    shell_regex: "^printf review-user",
  },
];

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

async function openClient(stateDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_POLICY_JSON: JSON.stringify(policyRules),
    }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-ticket05-" + label, version: "0.1.0" },
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

async function startShell(client, taskId, shell) {
  return client.callTool({
    name: "process.start",
    arguments: {
      task_id: taskId,
      shell,
      cwd: ".",
    },
  });
}

function approvalFrom(result) {
  assert.equal(result.isError, true);
  const payload = dataFrom(result);
  assert.equal(payload.error.code, "APPROVAL_REQUIRED");
  const request = payload.error.details?.approval_request;
  assert.ok(request, "APPROVAL_REQUIRED must contain approval_request");
  assert.equal(request.status, "PENDING");
  assert.match(request.approval_id, /^apr_[0-9a-f-]{36}$/);
  return request;
}

async function waitExited(client, taskId, processId) {
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

test("Ticket 05: deterministic policy and task-scoped smart approval are durable", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket05-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repoDir, "README.md"), "# approval demo\n", "utf8");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const opened = [];
  t.after(async () => {
    for (const entry of opened.reverse()) {
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
  opened.push(first);

  const tools = await first.client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  assert.equal(toolNames.has("approval.get"), true);
  assert.equal(toolNames.has("approval.respond"), true);

  const task = dataFrom(
    await first.client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  // Explicit deterministic allow executes without an approval request.
  const allowed = await startShell(
    first.client,
    task.task_id,
    "printf explicit-allow",
  );
  assert.notEqual(allowed.isError, true);
  const allowedProcess = dataFrom(allowed);
  assert.equal((await waitExited(first.client, task.task_id, allowedProcess.process_id)).exit_code, 0);

  // Explicit deterministic deny blocks before any process is created.
  const deniedByPolicy = await startShell(
    first.client,
    task.task_id,
    "printf explicit-deny",
  );
  assert.equal(deniedByPolicy.isError, true);
  assert.equal(dataFrom(deniedByPolicy).error.code, "POLICY_DENIED");

  // ALLOW_ONCE is consumed by exactly one retry.
  const onceRequest = approvalFrom(
    await startShell(first.client, task.task_id, "printf once-only"),
  );
  const onceResponse = dataFrom(
    await first.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: task.task_id,
        approval_id: onceRequest.approval_id,
        decision: "ALLOW_ONCE",
      },
    }),
  );
  assert.equal(onceResponse.approval.status, "APPROVED");
  assert.equal(onceResponse.grant.kind, "ALLOW_ONCE");

  const onceAllowed = dataFrom(
    await startShell(first.client, task.task_id, "printf once-only"),
  );
  await waitExited(first.client, task.task_id, onceAllowed.process_id);

  const onceAgain = approvalFrom(
    await startShell(first.client, task.task_id, "printf once-only"),
  );
  assert.notEqual(onceAgain.approval_id, onceRequest.approval_id);

  // DENY is a supported reviewer response.
  const denyRequest = approvalFrom(
    await startShell(first.client, task.task_id, "printf review-deny"),
  );
  const denyResponse = dataFrom(
    await first.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: task.task_id,
        approval_id: denyRequest.approval_id,
        decision: "DENY",
      },
    }),
  );
  assert.equal(denyResponse.approval.status, "DENIED");
  assert.equal(denyResponse.grant, null);

  // ASK_USER persists an unresolved escalation and can later be approved.
  const userRequest = approvalFrom(
    await startShell(first.client, task.task_id, "printf review-user"),
  );
  const userResponse = dataFrom(
    await first.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: task.task_id,
        approval_id: userRequest.approval_id,
        decision: "ASK_USER",
      },
    }),
  );
  assert.equal(userResponse.approval.status, "AWAITING_USER");

  const samePending = await startShell(
    first.client,
    task.task_id,
    "printf review-user",
  );
  assert.equal(samePending.isError, true);
  const pendingPayload = dataFrom(samePending);
  assert.equal(pendingPayload.error.code, "APPROVAL_REQUIRED");
  assert.equal(
    pendingPayload.error.details.approval_request.approval_id,
    userRequest.approval_id,
  );

  const userApproved = dataFrom(
    await first.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: task.task_id,
        approval_id: userRequest.approval_id,
        decision: "ALLOW_ONCE",
      },
    }),
  );
  assert.equal(userApproved.approval.status, "APPROVED");

  const userOperation = dataFrom(
    await startShell(first.client, task.task_id, "printf review-user"),
  );
  await waitExited(first.client, task.task_id, userOperation.process_id);

  // ALLOW_TASK grants the policy scope for this Task.
  const taskRequest = approvalFrom(
    await startShell(first.client, task.task_id, "printf task-approved-one"),
  );
  assert.equal(taskRequest.approval_scope, "safe-task-processes");

  const taskResponse = dataFrom(
    await first.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: task.task_id,
        approval_id: taskRequest.approval_id,
        decision: "ALLOW_TASK",
      },
    }),
  );
  assert.equal(taskResponse.grant.kind, "ALLOW_TASK");
  assert.equal(taskResponse.grant.approval_scope, "safe-task-processes");

  const taskAllowed = dataFrom(
    await startShell(first.client, task.task_id, "printf task-approved-one"),
  );
  await waitExited(first.client, task.task_id, taskAllowed.process_id);

  // Restart AgentDock with the same durable state. The task grant must remain.
  await first.client.close();
  const second = await openClient(stateDir, "second");
  opened.push(second);

  const resumed = dataFrom(
    await second.client.callTool({
      name: "task.resume",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(resumed.task_id, task.task_id);
  assert.equal(
    resumed.approval_grants.some(
      (grant) =>
        grant.kind === "ALLOW_TASK" &&
        grant.approval_scope === "safe-task-processes",
    ),
    true,
  );

  const equivalentAllowed = await startShell(
    second.client,
    task.task_id,
    "printf task-approved-two",
  );
  assert.notEqual(equivalentAllowed.isError, true);
  const equivalentProcess = dataFrom(equivalentAllowed);
  await waitExited(second.client, task.task_id, equivalentProcess.process_id);

  // A different Task gets no benefit from the first Task's grant.
  const otherTask = dataFrom(
    await second.client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );
  const otherRequest = approvalFrom(
    await startShell(second.client, otherTask.task_id, "printf task-approved-two"),
  );
  assert.equal(otherRequest.task_id, otherTask.task_id);
  assert.notEqual(otherRequest.task_id, task.task_id);

  const persisted = dataFrom(
    await second.client.callTool({
      name: "approval.get",
      arguments: {
        task_id: task.task_id,
        approval_id: taskRequest.approval_id,
      },
    }),
  );
  assert.equal(persisted.status, "APPROVED");
  assert.equal(persisted.decision, "ALLOW_TASK");
});
