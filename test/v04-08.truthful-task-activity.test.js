import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TaskActivityService } from "../src/task-activity-service.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dataFrom(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  return JSON.parse(text);
}

function fixture(overrides = {}) {
  const now = "2026-09-25T00:00:00.000Z";
  return {
    task: {
      task_id: "task_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "ACTIVE",
      approvals: [],
      created_at: now,
      updated_at: now,
      ...overrides.task,
    },
    processes: overrides.processes ?? [],
    activeProcesses: overrides.activeProcesses ?? [],
    latestPlan: overrides.latestPlan ?? null,
    changedFiles: overrides.changedFiles ?? [],
  };
}

test("v0.4 truthful activity derives every state without expanding lifecycle", () => {
  const service = new TaskActivityService();
  const state = (overrides) => service.derive(fixture(overrides)).activity_state;

  assert.equal(state({ task: { status: "COMPLETED" } }), "TERMINAL");
  assert.equal(state({
    latestPlan: { status: "RUNNING", updated_at: "2026-09-25T00:01:00Z" },
  }), "VERIFYING");
  assert.equal(state({
    activeProcesses: [{ process_id: "proc_active", status: "RUNNING" }],
  }), "EXECUTING");
  assert.equal(state({
    task: { approvals: [{ approval_id: "apr_1", status: "PENDING" }] },
  }), "AWAITING_APPROVAL");
  assert.equal(state({
    task: { approvals: [{ approval_id: "apr_1", status: "AWAITING_USER" }] },
  }), "AWAITING_USER");
  assert.equal(state({
    latestPlan: {
      plan_id: "plan_1",
      status: "AWAITING_ASSISTANT",
      blocker: { code: "PLAN_STEP_FAILED" },
    },
  }), "AWAITING_ASSISTANT");
  assert.equal(state({
    processes: [{
      process_id: "proc_interrupted",
      status: "INTERRUPTED",
      ended_at: "2026-09-25T00:02:00Z",
    }],
  }), "INTERRUPTED");
  assert.equal(state({ changedFiles: ["src/index.js"] }), "READY_TO_COMMIT");
  assert.equal(state({}), "READY_TO_FINISH");
});

test("v0.4 task.resume is observational and approval blockers outrank ready-to-finish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-activity-"));
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AgentDock Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "activity\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "fixture"]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
      AGENTDOCK_POLICY_JSON: JSON.stringify([{
        id: "ask-process",
        effect: "ask",
        tool: "process.start",
        approval_scope: "task-process",
      }]),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "activity-test", version: "1" });
  let task;
  t.after(async () => {
    try {
      if (task) {
        await client.callTool({ name: "task.cancel", arguments: { task_id: task.task_id } });
        await client.callTool({ name: "task.cleanup", arguments: { task_id: task.task_id } });
      }
    } catch {}
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  task = dataFrom(await client.callTool({
    name: "task.create",
    arguments: { repo_path: repo },
  }));
  const deniedStart = dataFrom(await client.callTool({
    name: "process.start",
    arguments: { task_id: task.task_id, shell: "printf blocked" },
  }));
  const approval = deniedStart.error.details.approval_request;

  const auditBefore = dataFrom(await client.callTool({
    name: "audit.get",
    arguments: { task_id: task.task_id },
  }));
  const first = dataFrom(await client.callTool({
    name: "task.resume",
    arguments: { task_id: task.task_id },
  }));
  const second = dataFrom(await client.callTool({
    name: "task.resume",
    arguments: { task_id: task.task_id },
  }));
  const auditAfter = dataFrom(await client.callTool({
    name: "audit.get",
    arguments: { task_id: task.task_id },
  }));

  assert.equal(first.activity_state, "AWAITING_APPROVAL");
  assert.equal(first.current_blocker.code, "APPROVAL_REQUIRED");
  assert.equal(first.recommended_next_action, "APPROVAL_REQUIRED");
  assert.equal(second.last_meaningful_progress_at, first.last_meaningful_progress_at);
  assert.equal(second.updated_at, first.updated_at);
  assert.equal(auditAfter.entries.length, auditBefore.entries.length);
  assert.equal(
    auditAfter.entries.some((entry) => entry.event === "TASK_RESUMED"),
    false,
  );

  await client.callTool({
    name: "approval.respond",
    arguments: {
      task_id: task.task_id,
      approval_id: approval.approval_id,
      decision: "ASK_USER",
    },
  });
  const awaitingUser = dataFrom(await client.callTool({
    name: "task.resume",
    arguments: { task_id: task.task_id },
  }));
  assert.equal(awaitingUser.activity_state, "AWAITING_USER");
  assert.equal(awaitingUser.recommended_next_action, "USER_INPUT_REQUIRED");
});
