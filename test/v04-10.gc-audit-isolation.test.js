import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentDockError } from "../src/errors.js";
import { createAgentDockRuntime } from "../src/server.js";

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AgentDock Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  return repo;
}

function ageCancelled(runtime, taskId) {
  runtime.taskService.mutate(taskId, (task) => {
    task.cancelled_at = "2020-01-01T00:00:00.000Z";
    task.updated_at = "2020-01-01T00:00:00.000Z";
  });
}

async function fixture(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const task = await runtime.taskService.create({ repoPath: repo });
  runtime.taskService.cancel(task.task_id);
  ageCancelled(runtime, task.task_id);
  t.after(async () => {
    await runtime.taskService.cleanup(task.task_id).catch(() => {});
    await runtime.closeExecution?.().catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, task };
}

test("v0.4 GC reports cleanup success even when success audit persistence fails", async (t) => {
  const { runtime, task } = await fixture(t, "agentdock-v04-gc-audit-success-");
  const preview = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  const originalAppend = runtime.auditService.append;
  runtime.auditService.append = () => {
    throw new AgentDockError("AUDIT_WRITE_FAILED", "injected audit failure");
  };

  let result;
  try {
    result = await runtime.taskReconcileService.gc({
      reconcileToken: preview.reconcile_token,
      taskIds: [task.task_id],
      staleAfterSeconds: 60,
    });
  } finally {
    runtime.auditService.append = originalAppend;
  }

  assert.equal(result.cleaned_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.results[0].disposition, "CLEANED");
  assert.equal(result.results[0].audit_recorded, false);
  assert.equal(result.results[0].audit_error_code, "AUDIT_WRITE_FAILED");
  assert.equal(runtime.taskService.get(task.task_id).workspace_cleaned, true);
});

test("v0.4 GC preserves the cleanup error when failure auditing also fails", async (t) => {
  const { runtime, task } = await fixture(t, "agentdock-v04-gc-audit-failure-");
  const preview = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  const originalCleanup = runtime.taskService.cleanup;
  const originalAppend = runtime.auditService.append;
  runtime.taskService.cleanup = async () => {
    throw new AgentDockError("INJECTED_CLEANUP_FAILURE", "injected cleanup failure");
  };
  runtime.auditService.append = () => {
    throw new AgentDockError("AUDIT_WRITE_FAILED", "injected audit failure");
  };

  let result;
  try {
    result = await runtime.taskReconcileService.gc({
      reconcileToken: preview.reconcile_token,
      taskIds: [task.task_id],
      staleAfterSeconds: 60,
    });
  } finally {
    runtime.taskService.cleanup = originalCleanup;
    runtime.auditService.append = originalAppend;
  }

  assert.equal(result.cleaned_count, 0);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].disposition, "FAILED");
  assert.equal(result.results[0].error_code, "INJECTED_CLEANUP_FAILURE");
  assert.equal(result.results[0].audit_recorded, false);
  assert.equal(result.results[0].audit_error_code, "AUDIT_WRITE_FAILED");
  assert.equal(runtime.taskService.get(task.task_id).workspace_cleaned, false);
});
