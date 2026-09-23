import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentDockRuntime } from "../src/server.js";

const TASK_NO_CHANGE = "task_00000000-0000-4000-8000-000000000001";
const TASK_COMMIT = "task_00000000-0000-4000-8000-000000000002";

async function configureProject(project) {
  await mkdir(path.join(project, "docs", "agents"), { recursive: true });
  await writeFile(path.join(project, "docs", "agents", "issue-tracker.md"), "# tracker\n");
  await writeFile(path.join(project, "docs", "agents", "domain.md"), "# domain\n");
  await writeFile(path.join(project, "AGENTS.md"), "# Agent\n\n## Agent skills\n");
}

function taskRecord({ id, repo, status = "COMPLETED", outcome, reason, commit, ref }) {
  const now = new Date().toISOString();
  return {
    task_id: id,
    status,
    source_repo: repo,
    base_head: "0".repeat(40),
    worktree_path: path.join(repo, ".worktree", id),
    process_ids: [],
    approvals: [],
    approval_grants: [],
    outcome: outcome ?? null,
    outcome_reason: reason ?? null,
    final_commit_sha: commit ?? null,
    retention_ref: ref ?? null,
    workspace_cleaned: false,
    created_at: now,
    updated_at: now,
  };
}

test("v0.4: guided workflow cannot claim implementation or review complete without durable evidence", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-evidence-"));
  const stateDir = path.join(tempRoot, "state");
  const project = path.join(tempRoot, "project");
  await mkdir(project);
  await configureProject(project);
  const repo = await realpath(project);

  const runtime = createAgentDockRuntime({ stateDir });
  t.after(async () => { await rm(tempRoot, { recursive: true, force: true }); });

  let guided = await runtime.workflowService.start({
    repoPath: project,
    goal: "Build evidence-gated development.",
    sessionSpan: "single",
    routeClarity: "clear",
    decisionsSettled: true,
  });
  assert.equal(guided.workflow.phase, "IMPLEMENT");

  await assert.rejects(
    runtime.workflowService.advance({ repoPath: project, event: "implementation_complete" }),
    (error) => error?.code === "WORKFLOW_IMPLEMENTATION_EVIDENCE_REQUIRED",
   );

  runtime.stateStore.saveTask(taskRecord({
    id: TASK_NO_CHANGE, repo, status: "ACTIVE", outcome: null,
  }));
  await runtime.workflowService.update({ repoPath: project, implementationTaskIds: [TASK_NO_CHANGE] });
  await assert.rejects(
    runtime.workflowService.advance({ repoPath: project, event: "implementation_complete" }),
    (error) => error?.code === "WORKFLOW_IMPLEMENTATION_INCOMPLETE",
   );

  runtime.stateStore.saveTask(taskRecord({
    id: TASK_NO_CHANGE, repo, outcome: "NO_CHANGE", reason: null,
  }));
  await assert.rejects(
    runtime.workflowService.advance({ repoPath: project, event: "implementation_complete" }),
    (error) => error?.code === "WORKFLOW_IMPLEMENTATION_EVIDENCE_INVALID",
  );

  runtime.stateStore.saveTask(taskRecord({
    id: TASK_NO_CHANGE, repo, outcome: "NO_CHANGE", reason: "No source change was required after verifying the behavior.",
  }));
  runtime.stateStore.saveTask(taskRecord({
    id: TASK_COMMIT, repo, outcome: "COMMIT", commit: "a".repeat(40), ref: "refs/agentdock/tasks/" + TASK_COMMIT,
  }));
  guided = await runtime.workflowService.update({
    repoPath: project,
    implementationTaskIds: [TASK_NO_CHANGE, TASK_COMMIT],
  });
  assert.deepEqual(guided.workflow.implementation_task_ids, [TASK_NO_CHANGE, TASK_COMMIT]);

  guided = await runtime.workflowService.advance({ repoPath: project, event: "implementation_complete" });
  assert.equal(guided.workflow.phase, "REVIEW");
  assert.equal(guided.workflow.implementation_evidence.units.length, 2);
  const fingerprint = guided.workflow.implementation_evidence.fingerprint;

  await assert.rejects(
    runtime.workflowService.advance({ repoPath: project, event: "review_passed" }),
    (error) => error?.code === "WORKFLOW_REVIEW_EVIDENCE_REQUIRED",
  );

  await runtime.workflowService.update({
    repoPath: project,
    reviewEvidence: {
      target_fingerprint: "b".repeat(64),
      standards: { result: "PASS", blocking_findings: 0 },
      spec: { result: "PASS", blocking_findings: 0 },
    },
  });
  await assert.rejects(
    runtime.workflowService.advance({ repoPath: project, event: "review_passed" }),
    (error) => error?.code === "WORKFLOW_REVIEW_TARGET_MISMATCH",
  );

  await runtime.workflowService.update({
    repoPath: project,
    reviewEvidence: {
      target_fingerprint: fingerprint,
      standards: { result: "FAIL", blocking_findings: 1 },
      spec: { result: "PASS", blocking_findings: 0 },
    },
  });
  await assert.rejects(
    runtime.workflowService.advance({ repoPath: project, event: "review_passed" }),
    (error) => error?.code === "WORKFLOW_REVIEW_BLOCKING_FINDINGS",
  );

  guided = await runtime.workflowService.update({
    repoPath: project,
    reviewEvidence: {
      target_fingerprint: fingerprint,
      standards: { result: "PASS", blocking_findings: 0 },
      spec: { result: "PASS", blocking_findings: 0 },
    },
  });
  guided = await runtime.workflowService.advance({ repoPath: project, event: "review_passed" });
  assert.equal(guided.workflow.phase, "DONE");
});
