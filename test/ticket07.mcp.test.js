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

const approvalSecret = "APPROVAL_SECRET_7";
const outputSecret = "LIVE_OUTPUT_SECRET_7";
const hostSecret = "HOST_FILE_SECRET_7";

const policyRules = [
  {
    id: "audit-safe-approval",
    effect: "ask",
    tool: "process.start",
    shell_regex: "^printf 'Authorization: Bearer",
    approval_scope: "audit-safe-process",
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
    { name: "agentdock-ticket07-" + label, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
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

function approvalFrom(result) {
  assert.equal(result.isError, true);
  const payload = dataFrom(result);
  assert.equal(payload.error.code, "APPROVAL_REQUIRED");
  return payload.error.details.approval_request;
}

test("Ticket 07: host access and structured audit preserve live fidelity and redact persisted audit", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket07-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const hostDir = path.join(tempRoot, "safe-host-area");
  const hostFile = path.join(hostDir, "host.txt");
  const stateDir = path.join(tempRoot, "agentdock-state");

  await mkdir(repoDir, { recursive: true });
  await mkdir(hostDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repoDir, "README.md"), "# ticket 07\n", "utf8");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);

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
        // Best-effort.
      }
    }
    await removeLinkedWorktrees(repoDir);
    await rm(tempRoot, { recursive: true, force: true });
  });

  const first = await openClient(stateDir, "first");
  opened.push(first);

  const tools = await first.client.listTools();
  assert.equal(
    tools.tools.some((tool) => tool.name === "audit.get"),
    true,
  );

  const task = dataFrom(
    await first.client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  // Workspace write/read remains the default for relative paths.
  const workspaceWrite = dataFrom(
    await first.client.callTool({
      name: "file.write",
      arguments: {
        task_id: task.task_id,
        path: "workspace-note.txt",
        content: "workspace data\n",
      },
    }),
  );
  assert.equal(workspaceWrite.access, "WORKSPACE_WRITE");
  assert.equal(workspaceWrite.path, "workspace-note.txt");

  const workspaceRead = dataFrom(
    await first.client.callTool({
      name: "file.read",
      arguments: {
        task_id: task.task_id,
        path: "workspace-note.txt",
      },
    }),
  );
  assert.equal(workspaceRead.access, "WORKSPACE_READ");
  assert.equal(workspaceRead.content, "workspace data\n");

  // Absolute paths use native host permissions and preserve live content.
  const hostWrite = dataFrom(
    await first.client.callTool({
      name: "file.write",
      arguments: {
        task_id: task.task_id,
        path: hostFile,
        content: "api_key=" + hostSecret + "\nhost data\n",
      },
    }),
  );
  assert.equal(hostWrite.access, "HOST_WRITE");
  assert.equal(hostWrite.path, hostFile);

  const hostRead = dataFrom(
    await first.client.callTool({
      name: "file.read",
      arguments: {
        task_id: task.task_id,
        path: hostFile,
      },
    }),
  );
  assert.equal(hostRead.access, "HOST_READ");
  assert.match(hostRead.content, new RegExp(hostSecret));
  assert.equal(
    await readFile(hostFile, "utf8"),
    "api_key=" + hostSecret + "\nhost data\n",
  );

  const hostPatch = dataFrom(
    await first.client.callTool({
      name: "file.patch",
      arguments: {
        task_id: task.task_id,
        path: hostFile,
        expected_sha256: hostRead.sha256,
        old_text: "host data",
        new_text: "host patched",
      },
    }),
  );
  assert.equal(hostPatch.access, "HOST_WRITE");

  // Approval is triggered on a harmless host-cwd process. The live command
  // output must remain unredacted for ChatGPT.
  const approvalShell =
    "printf 'Authorization: Bearer " + approvalSecret + "\\n'";
  const approvalRequest = approvalFrom(
    await first.client.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        shell: approvalShell,
        cwd: hostDir,
      },
    }),
  );
  assert.equal(approvalRequest.tool, "process.start");
  assert.equal(approvalRequest.operation.shell, approvalShell);
  assert.equal(approvalRequest.operation.cwd, hostDir);

  const approvalResponse = dataFrom(
    await first.client.callTool({
      name: "approval.respond",
      arguments: {
        task_id: task.task_id,
        approval_id: approvalRequest.approval_id,
        decision: "ALLOW_ONCE",
      },
    }),
  );
  assert.equal(approvalResponse.approval.status, "APPROVED");

  const approvedProcess = dataFrom(
    await first.client.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        shell: approvalShell,
        cwd: hostDir,
      },
    }),
  );

  const approvedExited = await waitFor(async () => {
    const status = dataFrom(
      await first.client.callTool({
        name: "process.status",
        arguments: {
          task_id: task.task_id,
          process_id: approvedProcess.process_id,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });
  assert.equal(approvedExited.exit_code, 0);
  assert.equal(approvedExited.cwd, hostDir);

  const approvedLiveOutput = dataFrom(
    await first.client.callTool({
      name: "process.output",
      arguments: {
        task_id: task.task_id,
        process_id: approvedProcess.process_id,
        cursor: 0,
      },
    }),
  );
  assert.match(approvedLiveOutput.stdout_chunk, new RegExp(approvalSecret));

  // Produce >64 KiB in one deterministic process. Live output is complete,
  // while only a bounded diagnostic tail is durable.
  const largeCode =
    'process.stdout.write("BEGIN7:" + "x".repeat(90000) + ":END7 TOKEN=' +
    outputSecret +
    '");';
  const largeProcess = dataFrom(
    await first.client.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        argv: [process.execPath, "-e", largeCode],
        cwd: ".",
        env: { API_KEY: "ENV_SECRET_7" },
      },
    }),
  );

  await waitFor(async () => {
    const status = dataFrom(
      await first.client.callTool({
        name: "process.status",
        arguments: {
          task_id: task.task_id,
          process_id: largeProcess.process_id,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });

  const largeLiveOutput = dataFrom(
    await first.client.callTool({
      name: "process.output",
      arguments: {
        task_id: task.task_id,
        process_id: largeProcess.process_id,
        cursor: 0,
      },
    }),
  );
  assert.match(largeLiveOutput.stdout_chunk, /^BEGIN7:/);
  assert.match(largeLiveOutput.stdout_chunk, /:END7 TOKEN=LIVE_OUTPUT_SECRET_7$/);
  assert.ok(Buffer.byteLength(largeLiveOutput.stdout_chunk, "utf8") > 80000);
  assert.equal(largeLiveOutput.persisted_output_truncated, false);

  // Commit the workspace change so the audit contains a real Git commit.
  const committed = dataFrom(
    await first.client.callTool({
      name: "git.commit",
      arguments: {
        task_id: task.task_id,
        message: "feat: audit workspace change",
      },
    }),
  );
  assert.match(committed.commit_sha, /^[0-9a-f]{40}$/);

  const auditBeforeRestart = dataFrom(
    await first.client.callTool({
      name: "audit.get",
      arguments: { task_id: task.task_id, limit: 1000 },
    }),
  );

  const events = auditBeforeRestart.entries.map((entry) => entry.event);
  for (const requiredEvent of [
    "TASK_CREATED",
    "FILE_WRITE",
    "FILE_READ",
    "FILE_PATCH",
    "APPROVAL_REQUESTED",
    "APPROVAL_RESPONDED",
    "PROCESS_STARTED",
    "PROCESS_ENDED",
    "GIT_COMMIT",
  ]) {
    assert.equal(events.includes(requiredEvent), true, "missing audit event " + requiredEvent);
  }

  assert.equal(
    auditBeforeRestart.entries.some(
      (entry) =>
        entry.event === "FILE_WRITE" &&
        entry.access === "WORKSPACE_WRITE" &&
        entry.path === "workspace-note.txt",
    ),
    true,
  );
  assert.equal(
    auditBeforeRestart.entries.some(
      (entry) =>
        entry.event === "FILE_WRITE" &&
        entry.access === "HOST_WRITE" &&
        entry.path === hostFile,
    ),
    true,
  );
  assert.equal(
    auditBeforeRestart.entries.some(
      (entry) =>
        entry.event === "FILE_READ" &&
        entry.access === "HOST_READ" &&
        entry.path === hostFile,
    ),
    true,
  );

  const processEnded = auditBeforeRestart.entries.find(
    (entry) =>
      entry.event === "PROCESS_ENDED" &&
      entry.process_id === approvedProcess.process_id,
  );
  assert.ok(processEnded);
  assert.equal(processEnded.exit_code, 0);
  assert.equal(processEnded.cwd, hostDir);
  assert.ok(processEnded.timestamp);
  assert.ok(processEnded.ended_at);

  const commitAudit = auditBeforeRestart.entries.find(
    (entry) =>
      entry.event === "GIT_COMMIT" &&
      entry.commit_sha === committed.commit_sha,
  );
  assert.ok(commitAudit);

  const serializedAudit = JSON.stringify(auditBeforeRestart);
  assert.equal(serializedAudit.includes(approvalSecret), false);
  assert.equal(serializedAudit.includes("ENV_SECRET_7"), false);
  assert.equal(serializedAudit.includes(outputSecret), false);
  assert.match(serializedAudit, /\[REDACTED\]/);

  // Restart AgentDock. Persisted process output is bounded while retaining a
  // diagnostic tail and explicitly reporting truncation.
  await first.client.close();
  const second = await openClient(stateDir, "second");
  opened.push(second);

  const resumed = dataFrom(
    await second.client.callTool({
      name: "task.resume",
      arguments: { task_id: task.task_id },
    }),
  );
  const restoredLarge = resumed.processes.find(
    (entry) => entry.process_id === largeProcess.process_id,
  );
  assert.ok(restoredLarge);
  assert.equal(restoredLarge.status, "EXITED");
  assert.equal(restoredLarge.persisted_output_truncated, true);

  const boundedOutput = dataFrom(
    await second.client.callTool({
      name: "process.output",
      arguments: {
        task_id: task.task_id,
        process_id: largeProcess.process_id,
        cursor: 0,
      },
    }),
  );
  assert.equal(boundedOutput.persisted_output_truncated, true);
  assert.ok(Buffer.byteLength(boundedOutput.stdout_chunk, "utf8") <= 65536);
  assert.match(boundedOutput.stdout_chunk, /:END7 TOKEN=\[REDACTED\]$/);
  assert.equal(boundedOutput.stdout_chunk.includes(outputSecret), false);

  const auditAfterRestart = dataFrom(
    await second.client.callTool({
      name: "audit.get",
      arguments: { task_id: task.task_id, limit: 1000 },
    }),
  );
  assert.ok(auditAfterRestart.entries.length > auditBeforeRestart.entries.length);
  assert.equal(
    JSON.stringify(auditAfterRestart).includes(approvalSecret),
    false,
  );

  // Host side effect remains after Git commit and AgentDock restart. AgentDock
  // audits it but does not pretend Git can roll it back.
  assert.equal(
    await readFile(hostFile, "utf8"),
    "api_key=" + hostSecret + "\nhost patched\n",
  );

  assert.equal(await git(repoDir, ["rev-parse", "HEAD"]), sourceHeadBefore);
  assert.equal(
    await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    sourceStatusBefore,
  );
});
