import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "AgentDock Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "AgentDock Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  return stdout.trim();
}

function data(result) {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-contract-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "app.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: { ...process.env, AGENTDOCK_STATE_DIR: path.join(root, "state"), AGENTDOCK_STATE_BACKEND: "sqlite" },
    stderr: "pipe",
  });
  const client = new Client({ name: "completion-contract-test", version: "0.4.0" }, { capabilities: {} });
  await client.connect(transport);
  return { root, repo, client };
}

test("v0.4 completion contract: required evidence fails closed and is tied to the final commit", async (t) => {
  const { root, repo, client } = await fixture();
  t.after(async () => { await client.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const task = data(await client.callTool({ name: "task.create", arguments: { repo_path: repo, completion_contract: { required: ["TARGETED_TESTS", "REVIEW"] } } }));

  let result = await client.callTool({ name: "task.finish", arguments: { task_id: task.task_id, outcome: "NO_CHANGE", reason: "No source change required." } });
  assert.equal(data(result).error.code, "TASK_COMPLETION_EVIDENCE_REQUIRED");
  await client.callTool({ name: "task.evidence.record", arguments: { task_id: task.task_id, kind: "TARGETED_TESTS", status: "FAIL", summary: "One targeted assertion failed." } });
  result = await client.callTool({ name: "task.finish", arguments: { task_id: task.task_id, outcome: "NO_CHANGE", reason: "No source change required." } });
  assert.equal(data(result).error.code, "TASK_COMPLETION_EVIDENCE_FAILED");

  for (const kind of ["TARGETED_TESTS", "REVIEW"]) {
    await client.callTool({ name: "task.evidence.record", arguments: { task_id: task.task_id, kind, status: "PASS", summary: kind + " passed." } });
  }
  await writeFile(path.join(task.worktree_path, "app.txt"), "changed\n");
  await git(task.worktree_path, ["add", "."]);
  await git(task.worktree_path, ["commit", "-m", "change"]);
  result = await client.callTool({ name: "task.finish", arguments: { task_id: task.task_id } });
  assert.equal(data(result).error.code, "TASK_COMPLETION_EVIDENCE_REQUIRED", "old PASS evidence cannot verify a new commit");

  for (const kind of ["TARGETED_TESTS", "REVIEW"]) {
    await client.callTool({ name: "task.evidence.record", arguments: { task_id: task.task_id, kind, status: "PASS", summary: kind + " passed on final commit." } });
  }
  const finished = data(await client.callTool({ name: "task.finish", arguments: { task_id: task.task_id } }));
  assert.equal(finished.status, "COMPLETED");
  assert.equal(finished.verification_status, "VERIFIED");
  assert.equal(finished.verification_evidence.subject_sha, finished.final_commit_sha);
});

test("v0.4 completion contract: NO_CHANGE needs both a reason and current required evidence", async (t) => {
  const { root, repo, client } = await fixture();
  t.after(async () => { await client.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const task = data(await client.callTool({ name: "task.create", arguments: { repo_path: repo, completion_contract: { required: ["PROVIDER_CHECK"] } } }));
  await client.callTool({ name: "task.evidence.record", arguments: { task_id: task.task_id, kind: "PROVIDER_CHECK", status: "PASS", summary: "Provider already exposes the required behavior." } });
  const missingReason = await client.callTool({ name: "task.finish", arguments: { task_id: task.task_id, outcome: "NO_CHANGE" } });
  assert.equal(data(missingReason).error.code, "TASK_NO_CHANGE_REASON_REQUIRED");
  const finished = data(await client.callTool({ name: "task.finish", arguments: { task_id: task.task_id, outcome: "NO_CHANGE", reason: "Provider behavior is already correct." } }));
  assert.equal(finished.verification_status, "VERIFIED");
  assert.equal(finished.outcome, "NO_CHANGE");
});

test("v0.4 completion contract: guided workflow fingerprints implementation and gates review", async (t) => {
  const { root, repo, client } = await fixture();
  await client.close();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(repo, "docs", "agents"), { recursive: true });
  await writeFile(path.join(repo, "docs", "agents", "issue-tracker.md"), "# tracker\n");
  await writeFile(path.join(repo, "docs", "agents", "domain.md"), "# domain\n");
  await writeFile(path.join(repo, "AGENTS.md"), "# Agent\n\n## Agent skills\n");
  const resolvedRepo = await realpath(repo);
  const runtime = createAgentDockRuntime({ stateDir: path.join(root, "workflow-state") });
  const taskId = "task_00000000-0000-4000-8000-000000000008";
  const now = new Date().toISOString();
  runtime.stateStore.saveTask({
    task_id: taskId,
    status: "COMPLETED",
    source_repo: resolvedRepo,
    base_head: "0".repeat(40),
    worktree_path: path.join(root, "gone"),
    outcome: "COMMIT",
    final_commit_sha: "1".repeat(40),
    retention_ref: "refs/agentdock/tasks/" + taskId,
    completion_contract: { required: ["REVIEW"] },
    verification_status: "VERIFIED",
    created_at: now,
    updated_at: now,
  });
  await runtime.workflowService.start({ repoPath: repo, goal: "verify workflow evidence", sessionSpan: "single", decisionsSettled: true });
  await runtime.workflowService.update({ repoPath: repo, implementationTaskIds: [taskId] });
  let guided = await runtime.workflowService.advance({ repoPath: repo, event: "implementation_complete" });
  const fingerprint = guided.workflow.implementation_evidence.fingerprint;
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  await assert.rejects(
    runtime.workflowService.advance({ repoPath: repo, event: "review_passed" }),
    { code: "WORKFLOW_REVIEW_EVIDENCE_REQUIRED" },
  );
  await runtime.workflowService.update({
    repoPath: repo,
    reviewEvidence: {
      target_fingerprint: fingerprint,
      standards: { result: "PASS", blocking_findings: 0 },
      spec: { result: "PASS", blocking_findings: 0 },
    },
  });
  guided = await runtime.workflowService.advance({ repoPath: repo, event: "review_passed" });
  assert.equal(guided.workflow.phase, "DONE");
});
