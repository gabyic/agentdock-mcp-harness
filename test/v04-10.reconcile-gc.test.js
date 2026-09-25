import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAgentDockRuntime } from "../src/server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function finishCommit(runtime, task, name) {
  await writeFile(path.join(task.worktree_path, name + ".txt"), name + "\n");
  const committed = await runtime.gitService.commit(task.worktree_path, { message: name });
  const retentionRef = await runtime.gitService.retainTaskCommit({ repoRoot: task.source_repo, taskId: task.task_id, commitSha: committed.commit_sha });
  return runtime.taskService.finish(task.task_id, { finalCommitSha: committed.commit_sha, outcome: "COMMIT", retentionRef });
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function ageFinalized(runtime, taskId) {
  runtime.taskService.mutate(taskId, (task) => {
    if (task.status === "COMPLETED") task.finished_at = "2020-01-01T00:00:00.000Z";
    if (task.status === "CANCELLED") task.cancelled_at = "2020-01-01T00:00:00.000Z";
    task.updated_at = "2020-01-01T00:00:00.000Z";
  });
}

test("v0.4 reconcile GC reclaims only retention-safe finalized worktrees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-gc-"));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const active = await runtime.taskService.create({ repoPath: repo });
  const completed = await runtime.taskService.create({ repoPath: repo });
  const cancelledClean = await runtime.taskService.create({ repoPath: repo });
  const cancelledDirty = await runtime.taskService.create({ repoPath: repo });
  const unretained = await runtime.taskService.create({ repoPath: repo });
  const cancelledAdvanced = await runtime.taskService.create({ repoPath: repo });
  const invalidNoChange = await runtime.taskService.create({ repoPath: repo });
  const noncanonical = await runtime.taskService.create({ repoPath: repo });
  const brokenRepo = await runtime.taskService.create({ repoPath: repo });
  const stateMismatch = await runtime.taskService.create({ repoPath: repo });
  const tasks = [active, completed, cancelledClean, cancelledDirty, unretained, cancelledAdvanced, invalidNoChange, noncanonical, brokenRepo, stateMismatch];
  t.after(async () => {
    for (const task of tasks) {
      try {
        if (runtime.taskService.get(task.task_id).status === "ACTIVE") runtime.taskService.cancel(task.task_id);
        await runtime.taskService.cleanup(task.task_id).catch(() => {});
      } catch {}
    }
    await runtime.closeExecution?.().catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(path.join(active.worktree_path, "active.txt"), "preserve\n");
  runtime.taskService.mutate(active.task_id, (task) => {
    task.created_at = "2020-01-01T00:00:00.000Z";
    task.updated_at = "2020-01-01T00:00:00.000Z";
  });
  const finished = await finishCommit(runtime, completed, "retained");
  ageFinalized(runtime, completed.task_id);
  runtime.taskService.cancel(cancelledClean.task_id);
  ageFinalized(runtime, cancelledClean.task_id);
  await writeFile(path.join(cancelledDirty.worktree_path, "dirty.txt"), "preserve\n");
  runtime.taskService.cancel(cancelledDirty.task_id);
  ageFinalized(runtime, cancelledDirty.task_id);
  const missingRetention = await finishCommit(runtime, unretained, "missing-retention");
  ageFinalized(runtime, unretained.task_id);
  execFileSync("git", ["-C", repo, "update-ref", "-d", missingRetention.retention_ref]);

  runtime.taskService.cancel(cancelledAdvanced.task_id);
  await writeFile(path.join(cancelledAdvanced.worktree_path, "advanced.txt"), "advanced\n");
  await runtime.gitService.commit(cancelledAdvanced.worktree_path, { message: "post-cancel commit" });
  ageFinalized(runtime, cancelledAdvanced.task_id);

  runtime.taskService.mutate(invalidNoChange.task_id, (task) => {
    task.status = "COMPLETED";
    task.final_commit_sha = task.base_head;
    task.outcome = "NO_CHANGE";
    task.outcome_reason = "";
    task.finished_at = new Date().toISOString();
  });
  ageFinalized(runtime, invalidNoChange.task_id);

  const retainedNoncanonical = await finishCommit(runtime, noncanonical, "noncanonical");
  runtime.taskService.mutate(noncanonical.task_id, (task) => {
    task.retention_ref = "refs/heads/main";
  });
  ageFinalized(runtime, noncanonical.task_id);
  assert.ok(retainedNoncanonical.final_commit_sha);

  runtime.taskService.finish(brokenRepo.task_id, {
    finalCommitSha: brokenRepo.base_head,
    outcome: "NO_CHANGE",
    outcomeReason: "verified no change",
  });
  runtime.taskService.mutate(brokenRepo.task_id, (task) => {
    task.source_repo = path.join(root, "missing-repo");
  });
  ageFinalized(runtime, brokenRepo.task_id);

  runtime.taskService.cancel(stateMismatch.task_id);
  ageFinalized(runtime, stateMismatch.task_id);
  runtime.taskService.mutate(stateMismatch.task_id, (task) => {
    task.workspace_cleaned = true;
  });

  const activeBefore = JSON.stringify(runtime.taskService.get(active.task_id));
  const preview = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  assert.equal(JSON.stringify(runtime.taskService.get(active.task_id)), activeBefore, "preview must be observational");
  assert.equal(preview.needs_attention.some((item) => item.task_id === active.task_id), true);
  assert.equal(preview.candidates.some((item) => item.task_id === active.task_id), false);
  assert.equal(
    preview.candidates.some((item) => item.task_id === completed.task_id),
    true,
    JSON.stringify(preview.blocked.find((item) => item.task_id === completed.task_id)),
  );
  assert.equal(preview.candidates.some((item) => item.task_id === cancelledClean.task_id), true);
  assert.equal(preview.blocked.find((item) => item.task_id === cancelledDirty.task_id).reason, "CANCELLED_WORKTREE_DIRTY");
  assert.equal(preview.blocked.find((item) => item.task_id === unretained.task_id).reason, "COMMIT_RETENTION_INVALID");
  assert.equal(preview.blocked.find((item) => item.task_id === cancelledAdvanced.task_id).reason, "FINALIZED_HEAD_MISMATCH");
  assert.equal(preview.blocked.find((item) => item.task_id === invalidNoChange.task_id).reason, "NO_CHANGE_OUTCOME_INVALID");
  assert.equal(preview.blocked.find((item) => item.task_id === noncanonical.task_id).reason, "COMMIT_RETENTION_NONCANONICAL");
  assert.equal(preview.blocked.find((item) => item.task_id === brokenRepo.task_id).reason, "FINALIZED_INSPECTION_FAILED");
  assert.equal(preview.blocked.find((item) => item.task_id === stateMismatch.task_id).reason, "CLEANUP_STATE_MISMATCH");
  await assert.rejects(
    runtime.taskReconcileService.gc({ reconcileToken: "0".repeat(64), taskIds: [completed.task_id], staleAfterSeconds: 60 }),
    { code: "RECONCILE_SNAPSHOT_CHANGED" },
  );
  await assert.rejects(
    runtime.taskReconcileService.gc({ reconcileToken: preview.reconcile_token, taskIds: [active.task_id], staleAfterSeconds: 60 }),
    { code: "GC_TASK_NOT_ELIGIBLE" },
  );

  const result = await runtime.taskReconcileService.gc({
    reconcileToken: preview.reconcile_token,
    taskIds: [completed.task_id, cancelledClean.task_id],
    staleAfterSeconds: 60,
  });
  assert.equal(result.cleaned_count, 2);
  const completedResult = result.results.find(
    (item) => item.task_id === completed.task_id,
  );
  assert.equal(
    completedResult.gc_safety_ref,
    "refs/agentdock/gc-safety/" + completed.task_id,
  );
  assert.equal(await exists(completed.worktree_path), false);
  assert.equal(await exists(cancelledClean.worktree_path), false);
  assert.equal(await exists(active.worktree_path), true);
  assert.equal(await exists(cancelledDirty.worktree_path), true);
  assert.equal(await exists(unretained.worktree_path), true);
  execFileSync("git", ["-C", repo, "reflog", "expire", "--expire=now", "--all"]);
  execFileSync("git", ["-C", repo, "gc", "--prune=now"]);
  assert.equal(execFileSync("git", ["-C", repo, "cat-file", "-t", finished.final_commit_sha], { encoding: "utf8" }).trim(), "commit");
  assert.equal(
    execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--verify", completedResult.gc_safety_ref + "^{commit}"],
      { encoding: "utf8" },
    ).trim(),
    finished.final_commit_sha,
  );
  const recoveredPath = path.join(root, "recovered-completed");
  execFileSync("git", [
    "-C",
    repo,
    "worktree",
    "add",
    "--detach",
    recoveredPath,
    completedResult.gc_safety_ref,
  ]);
  assert.equal(
    execFileSync("git", ["-C", recoveredPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    finished.final_commit_sha,
  );
  execFileSync("git", ["-C", repo, "worktree", "remove", recoveredPath]);
});

test("v0.4 Run-start reservation blocks terminal transition until durable registration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-gc-start-race-"));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const task = await runtime.taskService.create({ repoPath: repo });
  const processId = "proc_00000000-0000-4000-8000-000000000010";
  t.after(async () => {
    try {
      runtime.taskService.releaseProcessStart(task.task_id, processId);
      if (runtime.taskService.get(task.task_id).status === "ACTIVE") runtime.taskService.cancel(task.task_id);
      await runtime.taskService.cleanup(task.task_id).catch(() => {});
    } catch {}
    await runtime.closeExecution?.().catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  runtime.taskService.reserveProcessStart(task.task_id, processId);
  assert.throws(() => runtime.taskService.cancel(task.task_id), { code: "TASK_PROCESS_START_PENDING" });
  runtime.taskService.releaseProcessStart(task.task_id, processId);
  assert.equal(runtime.taskService.cancel(task.task_id).status, "CANCELLED");
});

test("v0.4 MCP exposes read-only reconcile and destructive explicit GC annotations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-gc-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: { ...process.env, AGENTDOCK_STATE_DIR: path.join(root, "state"), AGENTDOCK_STATE_BACKEND: "sqlite" },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentdock-v04-gc", version: "0.4.0" }, { capabilities: {} });
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const reconcile = tools.find((tool) => tool.name === "task.reconcile");
  const gc = tools.find((tool) => tool.name === "task.gc");
  assert.ok(reconcile);
  assert.ok(gc);
  assert.equal(reconcile.annotations?.readOnlyHint, true);
  assert.equal(reconcile.annotations?.destructiveHint, false);
  assert.equal(reconcile.annotations?.openWorldHint, false);
  assert.equal(gc.annotations?.readOnlyHint, false);
  assert.equal(gc.annotations?.destructiveHint, true);
  assert.equal(gc.annotations?.openWorldHint, false);

  const result = await client.callTool({ name: "task.reconcile", arguments: { stale_after_seconds: 60 } });
  const data = result.structuredContent ?? JSON.parse(result.content.find((entry) => entry.type === "text").text);
  assert.equal(data.candidate_count, 0);
  assert.match(data.reconcile_token, /^[0-9a-f]{64}$/);
});

test("v0.4 GC final HEAD lock rejects a clean commit raced after preview", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-gc-head-race-"));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const task = await runtime.taskService.create({ repoPath: repo });
  runtime.taskService.cancel(task.task_id);
  ageFinalized(runtime, task.task_id);
  const preview = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  assert.equal(preview.candidates.some((item) => item.task_id === task.task_id), true);

  const originalRemove = runtime.gitService.removeWorktree.bind(runtime.gitService);
  runtime.gitService.removeWorktree = async (options) => {
    await writeFile(path.join(task.worktree_path, "raced.txt"), "raced\n");
    await runtime.gitService.commit(task.worktree_path, { message: "raced after preview" });
    return originalRemove(options);
  };
  t.after(async () => {
    runtime.gitService.removeWorktree = originalRemove;
    await runtime.taskService.cleanup(task.task_id).catch(() => {});
    await runtime.closeExecution?.().catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const result = await runtime.taskReconcileService.gc({
    reconcileToken: preview.reconcile_token,
    taskIds: [task.task_id],
    staleAfterSeconds: 60,
  });
  assert.equal(result.cleaned_count, 0);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error_code, "TASK_GC_HEAD_MISMATCH");
  assert.equal(await exists(task.worktree_path), true);
  assert.equal(runtime.taskService.get(task.task_id).workspace_cleaned, false);
});

test("v0.4 GC rejects missing and symlink-substituted Task worktree paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-gc-path-"));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const missing = await runtime.taskService.create({ repoPath: repo });
  const substituted = await runtime.taskService.create({ repoPath: repo });
  const other = await runtime.taskService.create({ repoPath: repo });
  for (const task of [missing, substituted, other]) {
    runtime.taskService.cancel(task.task_id);
    ageFinalized(runtime, task.task_id);
  }
  t.after(async () => {
    await rm(substituted.worktree_path, { force: true }).catch(() => {});
    for (const task of [missing, substituted, other]) {
      await runtime.taskService.cleanup(task.task_id).catch(() => {});
    }
    await runtime.closeExecution?.().catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", missing.worktree_path]);
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", substituted.worktree_path]);
  await symlink(other.worktree_path, substituted.worktree_path);

  await assert.rejects(
    runtime.taskService.cleanup(missing.task_id, { requireClean: true }),
    { code: "TASK_GC_WORKTREE_MISSING" },
  );
  await assert.rejects(
    runtime.taskService.cleanup(substituted.task_id, { requireClean: true }),
    { code: "TASK_GC_WORKTREE_PATH_UNSAFE" },
  );
  const preview = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  assert.equal(preview.blocked.find((item) => item.task_id === missing.task_id).reason, "WORKTREE_MISSING_STATE_MISMATCH");
  assert.equal(preview.blocked.find((item) => item.task_id === substituted.task_id).reason, "WORKTREE_PATH_UNSAFE");
  assert.equal(await exists(other.worktree_path), true);
});

test("v0.4 GC never overwrites a conflicting recovery ref", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-gc-ref-conflict-"));
  const repo = await makeRepo(root);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "state") });
  const task = await runtime.taskService.create({ repoPath: repo });
  runtime.taskService.cancel(task.task_id);
  ageFinalized(runtime, task.task_id);

  await writeFile(path.join(repo, "new-source.txt"), "new source commit\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "source advances"]);
  const conflictingCommit = execFileSync(
    "git",
    ["-C", repo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const safetyRef = runtime.gitService.taskGcSafetyRef(task.task_id);
  execFileSync("git", ["-C", repo, "update-ref", safetyRef, conflictingCommit]);

  t.after(async () => {
    await runtime.taskService.cleanup(task.task_id).catch(() => {});
    await runtime.closeExecution?.().catch(() => {});
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const preview = await runtime.taskReconcileService.preview({ staleAfterSeconds: 60 });
  assert.equal(preview.candidates.some((item) => item.task_id === task.task_id), true);
  const result = await runtime.taskReconcileService.gc({
    reconcileToken: preview.reconcile_token,
    taskIds: [task.task_id],
    staleAfterSeconds: 60,
  });
  assert.equal(result.cleaned_count, 0);
  assert.equal(result.results[0].error_code, "TASK_GC_SAFETY_REF_CONFLICT");
  assert.equal(await exists(task.worktree_path), true);
  assert.equal(
    execFileSync("git", ["-C", repo, "rev-parse", safetyRef], {
      encoding: "utf8",
    }).trim(),
    conflictingCommit,
  );
});
