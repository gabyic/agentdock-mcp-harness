import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { AgentDockError } from "./errors.js";
import { loadAgentDockConfig } from "./config.js";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { FileEditService } from "./file-edit-service.js";
import { FileQueryService } from "./file-query-service.js";
import { GitService } from "./git-service.js";
import { IdempotencyService } from "./idempotency-service.js";
import { PlanService } from "./plan-service.js";
import { PolicyService } from "./policy-service.js";
import { createProcessExecution } from "./process-execution.js";
import { SkillService } from "./skill-service.js";
import { StateStore } from "./state-store.js";
import { TaskHygieneService } from "./task-hygiene-service.js";
import { TaskActivityService } from "./task-activity-service.js";
import { TaskReconcileService } from "./task-reconcile-service.js";
import { TaskService } from "./task-service.js";
import { WorkflowService } from "./workflow-service.js";
import { AGENTDOCK_VERSION } from "./version.js";

function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(error) {
  const payload =
    error instanceof AgentDockError
      ? {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        }
      : {
          error: {
            code: "INTERNAL_ERROR",
            message: error?.message ?? String(error),
          },
        };

  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function safe(handler) {
  return async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return toolError(error);
    }
  };
}

export const TOOL_RISK_PROFILES = Object.freeze({
  "repo.inspect": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "task.create": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "task.evidence.record": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "task.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "task.reconcile": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "task.gc": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "task.resume": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "task.finish": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "task.cancel": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "task.cleanup": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "file.read": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "file.search": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "file.patch": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "file.write": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "git.diff": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "git.commit": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "audit.get": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "approval.get": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "approval.respond": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "process.start": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "process.status": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "process.output": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "process.cancel": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "run.start": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "run.get": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "run.cancel": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "plan.start": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "plan.get": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "plan.cancel": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "plan.continue": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "skill.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "skill.search": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "skill.read": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "skill.invoke": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "skill.install": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "skill.update": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "workflow.start": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "workflow.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "workflow.status": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "workflow.update": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  "workflow.guide": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "workflow.advance": { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
});

function registerTool(
  server,
  name,
  description,
  inputShape,
  annotationsOrHandler,
  maybeHandler,
) {
  const hasAnnotations = typeof annotationsOrHandler !== "function";
  const handler = hasAnnotations ? maybeHandler : annotationsOrHandler;
  const supplementalAnnotations = hasAnnotations ? annotationsOrHandler : {};
  const riskProfile = TOOL_RISK_PROFILES[name];
  if (!riskProfile) {
    throw new AgentDockError(
      "MISSING_TOOL_RISK_PROFILE",
      "Every MCP tool must declare a complete directory-review risk profile.",
      { tool: name },
    );
  }
  const annotations = {
    ...(supplementalAnnotations ?? {}),
    ...riskProfile,
  };

  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object(inputShape),
      annotations,
    },
    handler,
  );
}

export function createAgentDockRuntime({ stateDir, config } = {}) {
  const resolvedConfig =
    config ??
    loadAgentDockConfig({
      overrides: stateDir ? { state: { dir: stateDir } } : {},
    }).config;

  const stateStore = new StateStore({
    stateDir: resolvedConfig.state.dir,
    backend: resolvedConfig.state.backend,
    maxPersistedOutputBytes:
      resolvedConfig.state.persisted_process_output_bytes,
  });
  const auditService = new AuditService({
    stateStore,
    maxEntriesPerTask: resolvedConfig.audit.max_entries_per_task,
  });
  const gitService = new GitService();
  const taskService = new TaskService({ gitService, stateStore });
  const policyService = new PolicyService({
    rules: resolvedConfig.policy.rules,
  });
  const approvalService = new ApprovalService({
    taskService,
    policyService,
    auditService,
  });
  const fileQueryService = new FileQueryService({
    taskService,
    auditService,
  });
  const fileEditService = new FileEditService({
    taskService,
    auditService,
  });
  const idempotencyService = new IdempotencyService({ stateStore });
  const execution = createProcessExecution({
    mode: resolvedConfig.execution.supervisor_mode,
    supervisorSocket: resolvedConfig.execution.supervisor_socket,
    taskService,
    stateStore,
    approvalService,
    auditService,
    idempotencyService,
  });
  const processService = execution.processService;
  const planService = new PlanService({
    stateStore,
    taskService,
    processService,
    auditService,
    gitService,
  });
  const taskActivityService = new TaskActivityService();
  const taskHygieneService = new TaskHygieneService({
    taskService,
    stateStore,
    gitService,
    taskActivityService,
  });
  const taskReconcileService = new TaskReconcileService({
    taskService,
    stateStore,
    taskHygieneService,
    gitService,
    auditService,
  });
  const skillService = new SkillService({
    stateStore,
    autoRoutingEnabled: resolvedConfig.skills.matt_auto_routing,
    routerSkillName: resolvedConfig.skills.router_skill,
  });
  const workflowService = new WorkflowService({
    stateStore,
    skillService,
    taskService,
  });

  return {
    stateStore,
    auditService,
    gitService,
    taskService,
    policyService,
    approvalService,
    fileQueryService,
    fileEditService,
    idempotencyService,
    processService,
    runSupervisor: execution.supervisor,
    supervisorMode: execution.supervisorMode,
    supervisorStatus: execution.supervisorStatus,
    closeExecution: async (options) => {
      planService.close();
      return execution.close(options);
    },
    planService,
    taskHygieneService,
    taskReconcileService,
    taskActivityService,
    skillService,
    workflowService,
    config: resolvedConfig,
  };
}

export function createAgentDockServer({ stateDir, runtime, config } = {}) {
  const services =
    runtime ?? createAgentDockRuntime({ stateDir, config });
  const {
    stateStore,
    auditService,
    gitService,
    taskService,
    approvalService,
    fileQueryService,
    fileEditService,
    processService,
    planService,
    taskHygieneService,
    taskReconcileService,
    taskActivityService,
    skillService,
    workflowService,
  } = services;

  const server = new McpServer(
    { name: "AgentDock", version: AGENTDOCK_VERSION },
    { capabilities: { tools: {} } },
  );

  registerTool(
    server,
    "repo.inspect",
    "Inspect a local Git repository without modifying its working tree.",
    { path: z.string().min(1).describe("Path inside the Git repository") },
    safe(async ({ path }) => toolResult(await gitService.inspect(path))),
  );

  registerTool(
    server,
    "task.create",
    "Create an ACTIVE coding task in a clean detached Git worktree based on source HEAD.",
    {
      repo_path: z.string().min(1).describe("Path inside the source Git repository"),
      completion_contract: z.object({
        required: z.array(z.enum([
          "TARGETED_TESTS", "FULL_SUITE", "STATIC_CHECK", "DIFF_CHECK",
          "MIGRATION_CHECK", "PROVIDER_CHECK", "REVIEW",
        ])).min(1),
      }).optional(),
    },
    safe(async ({ repo_path, completion_contract }) => {
      const task = await taskService.create({ repoPath: repo_path, completionContract: completion_contract });
      auditService.append(task.task_id, {
        event: "TASK_CREATED",
        status: task.status,
        source_repo: task.source_repo,
        base_head: task.base_head,
        worktree_path: task.worktree_path,
        source_dirty: task.source_dirty,
        created_at: task.created_at,
      });
      return toolResult(task);
    }),
  );

  registerTool(
    server,
    "task.evidence.record",
    "Record a durable PASS or FAIL completion check tied to the Task's current Git commit.",
    {
      task_id: z.string().min(1),
      kind: z.enum(["TARGETED_TESTS", "FULL_SUITE", "STATIC_CHECK", "DIFF_CHECK", "MIGRATION_CHECK", "PROVIDER_CHECK", "REVIEW"]),
      status: z.enum(["PASS", "FAIL"]),
      summary: z.string().min(1).max(10000),
      run_id: z.string().min(1).optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    },
    safe(async ({ task_id, kind, status, summary, run_id, details }) => {
      const task = taskService.assertActive(task_id);
      const subjectSha = await gitService.currentHead(task.worktree_path);
      const recorded = taskService.recordEvidence(task_id, {
        kind, status, summary, subjectSha, runId: run_id, details,
      });
      auditService.append(task_id, { event: "TASK_COMPLETION_EVIDENCE_RECORDED", ...recorded.result });
      return toolResult({ evidence: recorded.result, completion: taskService.completionEvidence(recorded.task, subjectSha) });
    }),
  );

  registerTool(
    server,
    "task.list",
    "List durable Tasks and hygiene/storage status. This is observational only: it never cleans, deletes, resumes, or mutates a Task.",
    {
      stale_after_seconds: z.number().int().min(60).max(31536000).optional(),
      include_finalized: z.boolean().optional(),
    },
    safe(async ({ stale_after_seconds, include_finalized }) =>
      toolResult(
        await taskHygieneService.list({
          staleAfterSeconds: stale_after_seconds ?? 3600,
          includeFinalized: include_finalized ?? true,
        }),
      )),
  );

  registerTool(
    server,
    "task.reconcile",
    "Preview retention-aware GC eligibility. ACTIVE Tasks are never selected; stale ACTIVE Tasks are reported as NEEDS_ATTENTION.",
    {
      stale_after_seconds: z.number().int().min(60).max(31536000).optional(),
    },
    safe(async ({ stale_after_seconds }) =>
      toolResult(await taskReconcileService.preview({ staleAfterSeconds: stale_after_seconds ?? 3600 }))),
  );

  registerTool(
    server,
    "task.gc",
    "Clean only explicitly selected finalized Task worktrees from an unchanged task.reconcile snapshot.",
    {
      reconcile_token: z.string().regex(/^[0-9a-f]{64}$/),
      task_ids: z.array(z.string().min(1)).min(1).max(1000),
      stale_after_seconds: z.number().int().min(60).max(31536000).optional(),
    },
    safe(async ({ reconcile_token, task_ids, stale_after_seconds }) =>
      toolResult(await taskReconcileService.gc({
        reconcileToken: reconcile_token,
        taskIds: task_ids,
        staleAfterSeconds: stale_after_seconds ?? 3600,
      }))),
  );

  registerTool(
    server,
    "task.resume",
    "Resume a durable Workspace Task with a compact bounded process summary and the next lifecycle action.",
    {
      task_id: z.string().min(1),
      process_limit: z.number().int().min(1).max(50).optional(),
    },
    safe(async ({ task_id, process_limit }) => {
      const task = taskService.resume(task_id);
      const processCount = task.process_ids?.length ?? 0;
      const limit = process_limit ?? 5;
      const processes = await processService.summariesForTask(task_id, {
        limit,
        compact: true,
      });
      const activeProcesses = await processService.activeForTask(task_id);
      const latestPlan = planService.latestForTask(task_id);
      const diff = await gitService.diff(task.worktree_path);
      const subjectSha = await gitService.currentHead(task.worktree_path);
      const completionEvidence = taskService.completionEvidence(task, subjectSha);
      const allProcesses = stateStore
        .listProcessMetadata()
        .filter((process) => process.task_id === task_id);
      const activity = taskActivityService.derive({
        task,
        processes: allProcesses,
        activeProcesses,
        latestPlan,
        changedFiles: diff.changed_files,
        completionEvidence,
      });
      const { process_ids: _processIds, ...taskSummary } = task;
      return toolResult({
        ...taskSummary,
        process_count: processCount,
        processes,
        active_processes: activeProcesses,
        process_history_truncated: processCount > processes.length,
        latest_plan: latestPlan,
        completion: completionEvidence,
        ...activity,
      });
    }),
  );

  registerTool(
    server,
    "task.finish",
    "Explicitly mark an ACTIVE Task COMPLETED after processes stop and the worktree is clean. A new commit is recorded as COMMIT automatically; an unchanged Task requires explicit outcome=NO_CHANGE with a reason.",
    {
      task_id: z.string().min(1),
      outcome: z.enum(["COMMIT", "NO_CHANGE"]).optional(),
      reason: z.string().min(1).max(10000).optional(),
    },
    safe(async ({ task_id, outcome, reason }) => {
      const task = taskService.assertActive(task_id);
      const active = await processService.activeForTask(task_id);
      if (active.length > 0) {
        throw new AgentDockError(
          "TASK_PROCESSES_ACTIVE",
          "Task still has running or cancelling processes.",
          { processes: active },
        );
      }

      const latestPlan = planService.latestForTask(task_id);
      if (["RUNNING", "AWAITING_ASSISTANT", "AWAITING_APPROVAL", "AWAITING_USER"].includes(latestPlan?.status)) {
        throw new AgentDockError(
          "TASK_PLAN_ACTIVE",
          "Task still has a running deterministic Plan.",
          { plan_id: latestPlan.plan_id },
        );
      }

      const diff = await gitService.diff(task.worktree_path);
      if (diff.changed_files.length > 0) {
        throw new AgentDockError(
          "TASK_UNCOMMITTED_CHANGES",
          "Task worktree must be clean before finish.",
          { changed_files: diff.changed_files },
        );
      }

      const finalCommitSha = await gitService.currentHead(task.worktree_path);
      const hasNewCommit = finalCommitSha !== task.base_head;
      let finalOutcome = outcome ?? null;

      if (finalOutcome === null) {
        if (hasNewCommit) {
          finalOutcome = "COMMIT";
        } else {
          throw new AgentDockError(
            "TASK_OUTCOME_REQUIRED",
            "A Task with no new commit must explicitly finish as NO_CHANGE with a reason.",
          );
        }
      }

      if (finalOutcome === "COMMIT" && !hasNewCommit) {
        throw new AgentDockError(
          "TASK_COMMIT_REQUIRED",
          "COMMIT outcome requires a Task commit newer than the source base HEAD.",
          {
            base_head: task.base_head,
            final_commit_sha: finalCommitSha,
          },
        );
      }

      const cleanReason = String(reason ?? "").trim();
      if (finalOutcome === "NO_CHANGE") {
        if (hasNewCommit) {
          throw new AgentDockError(
            "TASK_NO_CHANGE_HAS_COMMIT",
            "NO_CHANGE cannot hide a new Task commit; finish with COMMIT instead.",
            { final_commit_sha: finalCommitSha },
          );
        }
        if (!cleanReason) {
          throw new AgentDockError(
            "TASK_NO_CHANGE_REASON_REQUIRED",
            "NO_CHANGE requires a non-empty reason/evidence.",
          );
        }
      }

      const completion = taskService.completionEvidence(task, finalCommitSha);
      if (!completion.satisfied) {
        const failed = completion.results.filter((result) => result.state === "FAIL");
        throw new AgentDockError(
          failed.length > 0 ? "TASK_COMPLETION_EVIDENCE_FAILED" : "TASK_COMPLETION_EVIDENCE_REQUIRED",
          failed.length > 0
            ? "A required completion check is known to be failing."
            : "Required completion evidence is missing or targets an older implementation result.",
          { completion },
        );
      }

      const retentionRef =
        finalOutcome === "COMMIT"
          ? await gitService.retainTaskCommit({
              repoRoot: task.source_repo,
              taskId: task_id,
              commitSha: finalCommitSha,
            })
          : null;

      const finished = taskService.finish(task_id, {
        finalCommitSha,
        outcome: finalOutcome,
        outcomeReason: finalOutcome === "NO_CHANGE" ? cleanReason : null,
        retentionRef,
      });
      auditService.append(task_id, {
        event: "TASK_FINISHED",
        status: finished.status,
        outcome: finished.outcome,
        outcome_reason: finished.outcome_reason,
        final_commit_sha: finished.final_commit_sha,
        retention_ref: finished.retention_ref,
        finished_at: finished.finished_at,
      });
      return toolResult(finished);
    }),
  );

  registerTool(
    server,
    "task.cancel",
    "Cancel an ACTIVE Task, best-effort stopping its running processes while preserving the worktree.",
    { task_id: z.string().min(1) },
    safe(async ({ task_id }) => {
      taskService.assertActive(task_id);
      const cancelledProcesses = await processService.cancelAllForTask(task_id);
      const task = taskService.cancel(task_id);
      auditService.append(task_id, {
        event: "TASK_CANCELLED",
        status: task.status,
        cancelled_process_ids: cancelledProcesses.map(
          (process) => process.process_id,
        ),
        cancelled_at: task.cancelled_at,
      });
      return toolResult({
        ...task,
        cancelled_processes: cancelledProcesses,
      });
    }),
  );

  registerTool(
    server,
    "task.cleanup",
    "Remove the worktree of a COMPLETED or CANCELLED Task while preserving durable Task metadata.",
    { task_id: z.string().min(1) },
    safe(async ({ task_id }) => {
      const active = await processService.activeForTask(task_id);
      if (active.length > 0) {
        throw new AgentDockError(
          "TASK_PROCESSES_ACTIVE",
          "Wait for running/cancelling processes to stop before cleanup.",
          { processes: active },
        );
      }

      const cleaned = await taskService.cleanup(task_id);
      auditService.append(task_id, {
        event: "TASK_CLEANED",
        status: cleaned.status,
        worktree_path: cleaned.worktree_path,
        cleaned_at: cleaned.cleaned_at,
      });
      return toolResult(cleaned);
    }),
  );

  registerTool(
    server,
    "file.read",
    "Read a UTF-8 file. Relative paths use the Task worktree; absolute paths use the host OS.",
    {
      task_id: z.string().min(1),
      path: z.string().min(1),
    },
    safe(async ({ task_id, path }) =>
      toolResult(
        await fileQueryService.read({
          taskId: task_id,
          filePath: path,
        }),
      )),
  );

  registerTool(
    server,
    "file.search",
    "Search files using deterministic text matching and a glob. Relative paths use the Task worktree; absolute paths use the host OS.",
    {
      task_id: z.string().min(1),
      query: z.string().min(1),
      path: z.string().optional(),
      glob: z.string().optional(),
      max_results: z.number().int().min(1).max(1000).optional(),
    },
    safe(async ({ task_id, query, path, glob, max_results }) =>
      toolResult(
        await fileQueryService.search({
          taskId: task_id,
          query,
          searchPath: path,
          glob,
          maxResults: max_results,
        }),
      )),
  );

  registerTool(
    server,
    "file.patch",
    "Patch an existing file if its SHA-256 still matches. Relative paths use the Task worktree; absolute paths use the host OS.",
    {
      task_id: z.string().min(1),
      path: z.string().min(1),
      expected_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      old_text: z.string().min(1),
      new_text: z.string(),
    },
    safe(async ({
      task_id,
      path,
      expected_sha256,
      old_text,
      new_text,
    }) =>
      toolResult(
        await fileEditService.patch({
          taskId: task_id,
          filePath: path,
          expectedSha256: expected_sha256,
          oldText: old_text,
          newText: new_text,
        }),
      )),
  );

  registerTool(
    server,
    "file.write",
    "Create or replace a UTF-8 file. Relative paths use the Task worktree; absolute paths use the host OS.",
    {
      task_id: z.string().min(1),
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().optional(),
    },
    safe(async ({ task_id, path, content, overwrite }) =>
      toolResult(
        await fileEditService.write({
          taskId: task_id,
          filePath: path,
          content,
          overwrite,
        }),
      )),
  );

  registerTool(
    server,
    "git.diff",
    "Return structured Task worktree changes and unified diff, including untracked files.",
    { task_id: z.string().min(1) },
    safe(async ({ task_id }) => {
      const task = taskService.get(task_id);
      return toolResult({
        task_id,
        ...(await gitService.diff(task.worktree_path)),
      });
    }),
  );


  registerTool(
    server,
    "git.commit",
    "Stage all Task worktree changes and create a real local Git commit without push, merge, or deploy.",
    {
      task_id: z.string().min(1),
      message: z.string().min(1).max(10000),
    },
    safe(async ({ task_id, message }) => {
      const task = taskService.assertActive(task_id);
      const result = await gitService.commit(task.worktree_path, { message });
      taskService.recordCommit(task_id, result.commit_sha);
      auditService.append(task_id, {
        event: "GIT_COMMIT",
        commit_sha: result.commit_sha,
        message: result.message,
        committed_files: result.committed_files,
        worktree_clean: result.worktree_clean,
      });
      return toolResult({
        task_id,
        ...result,
      });
    }),
  );


  registerTool(
    server,
    "audit.get",
    "Return structured persisted Task audit entries after a sequence cursor.",
    {
      task_id: z.string().min(1),
      after_sequence: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    safe(async ({ task_id, after_sequence, limit }) => {
      taskService.get(task_id);
      return toolResult(
        auditService.get(task_id, {
          afterSequence: after_sequence,
          limit,
        }),
      );
    }),
  );

  registerTool(
    server,
    "approval.get",
    "Return a durable approval request by Task and approval_id.",
    {
      task_id: z.string().min(1),
      approval_id: z.string().min(1),
    },
    safe(async ({ task_id, approval_id }) =>
      toolResult(
        approvalService.get({
          taskId: task_id,
          approvalId: approval_id,
        }),
      )),
  );

  registerTool(
    server,
    "approval.respond",
    "Resolve or escalate a durable approval request.",
    {
      task_id: z.string().min(1),
      approval_id: z.string().min(1),
      decision: z.enum([
        "ALLOW_ONCE",
        "ALLOW_TASK",
        "DENY",
        "ASK_USER",
      ]),
    },
    safe(async ({ task_id, approval_id, decision }) =>
      toolResult(
        approvalService.respond({
          taskId: task_id,
          approvalId: approval_id,
          decision,
        }),
      )),
  );

  registerTool(
    server,
    "process.start",
    "Start an asynchronous Task process using explicit argv or shell mode.",
    {
      task_id: z.string().min(1),
      argv: z.array(z.string()).min(1).optional(),
      shell: z.string().min(1).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
    },
    safe(async ({ task_id, argv, shell, cwd, env, idempotency_key }) =>
      toolResult(
        await processService.start({
          taskId: task_id,
          argv,
          shell,
          cwd,
          env,
          idempotencyKey: idempotency_key,
        }),
      )),
  );

  registerTool(
    server,
    "process.status",
    "Return current status and execution metadata for a Task process.",
    {
      task_id: z.string().min(1),
      process_id: z.string().min(1),
    },
    safe(async ({ task_id, process_id }) =>
      toolResult(
        await processService.status({ taskId: task_id, processId: process_id }),
      )),
  );

  registerTool(
    server,
    "process.output",
    "Read bounded process stdout/stderr incrementally from a pull cursor.",
    {
      task_id: z.string().min(1),
      process_id: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      max_bytes: z.number().int().min(16384).max(32768).optional(),
      max_chunks: z.number().int().min(1).max(128).optional(),
    },
    safe(async ({ task_id, process_id, cursor, max_bytes, max_chunks }) =>
      toolResult(
        await processService.output({
          taskId: task_id,
          processId: process_id,
          cursor,
          maxBytes: max_bytes,
          maxChunks: max_chunks,
        }),
      )),
  );

  registerTool(
    server,
    "process.cancel",
    "Best-effort cancel a running Task process and its Linux process group.",
    {
      task_id: z.string().min(1),
      process_id: z.string().min(1),
    },
    safe(async ({ task_id, process_id }) =>
      toolResult(
        await processService.cancel({ taskId: task_id, processId: process_id }),
      )),
  );

  registerTool(
    server,
    "run.start",
    "Start a durable asynchronous Run inside a Workspace Task. Returns a run_id immediately; use run.get for bounded long-poll output.",
    {
      task_id: z.string().min(1),
      argv: z.array(z.string()).min(1).optional(),
      shell: z.string().min(1).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
    },
    safe(async ({ task_id, argv, shell, cwd, env, idempotency_key }) => {
      const started = await processService.start({
        taskId: task_id,
        argv,
        shell,
        cwd,
        env,
        idempotencyKey: idempotency_key,
      });
      return toolResult({
        run_id: started.process_id,
        task_id: started.task_id,
        status: started.status,
        started_at: started.started_at,
        poll_after_ms: 1000,
        idempotent_replay: Boolean(started.idempotent_replay),
      });
    }),
  );

  registerTool(
    server,
    "run.get",
    "Read one bounded page of Run output, optionally waiting up to 10 seconds for output or a terminal state.",
    {
      task_id: z.string().min(1),
      run_id: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      wait_ms: z.number().int().min(0).max(10000).optional(),
      max_bytes: z.number().int().min(16384).max(32768).optional(),
      max_chunks: z.number().int().min(1).max(128).optional(),
    },
    safe(async ({
      task_id,
      run_id,
      cursor,
      wait_ms,
      max_bytes,
      max_chunks,
    }) => {
      const result = await processService.wait({
        taskId: task_id,
        processId: run_id,
        cursor,
        waitMs: wait_ms,
        maxBytes: max_bytes,
        maxChunks: max_chunks,
      });
      const { chunks: _chunks, process_id: _processId, ...runResult } = result;
      return toolResult({ run_id, ...runResult });
    }),
  );

  registerTool(
    server,
    "run.cancel",
    "Cancel a Run owned by this AgentDock execution runtime.",
    {
      task_id: z.string().min(1),
      run_id: z.string().min(1),
    },
    safe(async ({ task_id, run_id }) => {
      const cancelled = await processService.cancel({
        taskId: task_id,
        processId: run_id,
      });
      return toolResult({ run_id, ...cancelled });
    }),
  );


  registerTool(
    server,
    "plan.start",
    "Start an idempotent durable deterministic Plan with dependencies, evidence, explicit barriers, safe retries, and optional guarded commit/finish actions.",
    {
      task_id: z.string().min(1),
      idempotency_key: z.string().min(1).max(256),
      steps: z.array(
        z.object({
          step_id: z.string().min(1).max(128),
          action: z.enum(["COMMAND", "REASONING_BARRIER", "HUMAN_BARRIER", "GIT_COMMIT", "TASK_FINISH"]).optional(),
          depends_on: z.array(z.string().min(1).max(128)).optional(),
          idempotency_key: z.string().min(1).max(256).optional(),
          argv: z.array(z.string()).min(1).optional(),
          shell: z.string().min(1).optional(),
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(1000).max(1800000).optional(),
          success_criteria: z.object({ exit_codes: z.array(z.number().int()).min(1) }).optional(),
          evidence: z.object({
            kind: z.enum(["TARGETED_TESTS", "FULL_SUITE", "STATIC_CHECK", "DIFF_CHECK", "MIGRATION_CHECK", "PROVIDER_CHECK", "REVIEW"]),
            summary: z.string().min(1).max(10000),
          }).optional(),
          retry: z.object({ safe: z.boolean(), max_attempts: z.number().int().min(1).max(3) }).optional(),
          message: z.string().min(1).max(10000).optional(),
          outcome: z.enum(["COMMIT", "NO_CHANGE"]).optional(),
          reason: z.string().min(1).max(10000).optional(),
          prompt: z.string().min(1).max(10000).optional(),
        }),
      ).min(1).max(32),
    },
    safe(async ({ task_id, idempotency_key, steps }) =>
      toolResult(
        planService.start({
          taskId: task_id,
          idempotencyKey: idempotency_key,
          steps,
        }),
      )),
  );

  registerTool(
    server,
    "plan.continue",
    "Continue a Plan after its explicit reasoning, human-confirmation, or resolved approval barrier. Failed command/action steps cannot be auto-continued.",
    {
      task_id: z.string().min(1),
      plan_id: z.string().min(1),
      step_id: z.string().min(1),
      note: z.string().max(10000).optional(),
    },
    safe(async ({ task_id, plan_id, step_id, note }) =>
      toolResult(planService.continue({ taskId: task_id, planId: plan_id, stepId: step_id, note }))),
  );

  registerTool(
    server,
    "plan.get",
    "Read durable Plan progress, optionally waiting up to 10 seconds for its revision or terminal status to change.",
    {
      task_id: z.string().min(1),
      plan_id: z.string().min(1),
      after_revision: z.number().int().min(0).optional(),
      wait_ms: z.number().int().min(0).max(10000).optional(),
    },
    safe(async ({ task_id, plan_id, after_revision, wait_ms }) =>
      toolResult(
        await planService.wait({
          taskId: task_id,
          planId: plan_id,
          afterRevision: after_revision,
          waitMs: wait_ms,
        }),
      )),
  );

  registerTool(
    server,
    "plan.cancel",
    "Request durable cancellation of a deterministic Plan. The owning runtime stops after the current Run settles; local Runs are cancelled best-effort immediately.",
    {
      task_id: z.string().min(1),
      plan_id: z.string().min(1),
    },
    safe(async ({ task_id, plan_id }) =>
      toolResult(
        await planService.cancel({
          taskId: task_id,
          planId: plan_id,
        }),
      )),
  );


  registerTool(
    server,
    "skill.list",
    "List installed server-side skills without invoking or executing them.",
    {
      source_id: z.string().optional(),
    },
    safe(async ({ source_id }) =>
      toolResult(await skillService.list({ sourceId: source_id })),
    ),
  );

  registerTool(
    server,
    "skill.search",
    "Search installed server-side skills by name, category, and description.",
    {
      query: z.string().min(1),
      source_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    safe(async ({ query, source_id, limit }) =>
      toolResult(
        await skillService.search({
          query,
          sourceId: source_id,
          limit,
        }),
      )),
  );

  registerTool(
    server,
    "skill.read",
    "Read the recommended installed SKILL.md or one of its supporting files. Follow the returned instructions in the chat model; if they reference another skill or local resource, read that resource explicitly instead of treating skills as executable server code.",
    {
      skill_name: z.string().min(1),
      source_id: z.string().optional(),
      resource_path: z.string().optional(),
    },
    safe(async ({ skill_name, source_id, resource_path }) =>
      toolResult(
        await skillService.read({
          skillName: skill_name,
          sourceId: source_id,
          resourcePath: resource_path,
        }),
      )),
  );

  registerTool(
    server,
    "skill.invoke",
    "Use this as AgentDock's Matt workflow router and Skill loader for software-engineering work. When the user selected @AgentDock but did not name a Matt skill, proactively call skill.invoke with skill_name=\"auto\", invocation_mode=\"model\", the user's request, and repo_path when known. This returns Ask Matt routing instructions, installed Skill candidates, and durable workflow context; choose the best Skill from that evidence, then call skill.invoke again with the chosen Skill name. Typical routing includes foggy/large work -> wayfinder, repository idea clarification -> grill-with-docs, existing spec/ticket -> implement, hard bug -> diagnosing-bugs, completed change -> code-review, research -> research. Do not start a second server-side LLM, invent product decisions, bypass approvals, or cross unresolved workflow boundaries. User-invoked upstream Skills remain fail-closed unless explicitly named by the human or covered by configured Auto Matt authorization.",
    {
      skill_name: z.string().min(1),
      request: z.string().min(1),
      invocation_mode: z.enum(["user", "model"]).optional(),
      source_id: z.string().optional(),
      repo_path: z.string().optional(),
    },
    safe(async ({
      skill_name,
      request,
      invocation_mode,
      source_id,
      repo_path,
    }) => {
      const invocation = await skillService.invoke({
        skillName: skill_name,
        sourceId: source_id,
        invocationMode: invocation_mode,
        request,
      });

      let workflowContext = null;
      if (repo_path) {
        try {
          workflowContext = await workflowService.status({
            repoPath: repo_path,
          });
        } catch (error) {
          if (
            error instanceof AgentDockError &&
            error.code === "WORKFLOW_NOT_FOUND"
          ) {
            workflowContext = {
              state: "NOT_STARTED",
              repo_path,
            };
          } else {
            throw error;
          }
        }
      }

      const routedInvocation =
        invocation.routing && workflowContext?.recommendation?.skill
          ? {
              ...invocation,
              routing: {
                ...invocation.routing,
                workflow_recommended_skill:
                  workflowContext.recommendation.skill,
                workflow_recommendation_reason:
                  workflowContext.recommendation.reason,
              },
            }
          : invocation;

      return toolResult({
        ...routedInvocation,
        workflow_context: workflowContext,
      });
    }),
  );

  registerTool(
    server,
    "skill.install",
    "Install a Git-backed skill source into AgentDock state. This stores instructions only; it does not execute a skill or run an LLM.",
    {
      source_id: z.string().min(1),
      repo_url: z.string().min(1),
      ref: z.string().min(1).optional(),
      replace: z.boolean().optional(),
    },
    safe(async ({ source_id, repo_url, ref, replace }) =>
      toolResult(
        await skillService.install({
          sourceId: source_id,
          repoUrl: repo_url,
          ref,
          replace,
        }),
      )),
  );

  registerTool(
    server,
    "skill.update",
    "Reinstall an existing skill source from its recorded Git URL/ref and report whether the source commit changed.",
    {
      source_id: z.string().min(1),
    },
    safe(async ({ source_id }) =>
      toolResult(await skillService.update({ sourceId: source_id })),
    ),
  );

  registerTool(
    server,
    "workflow.start",
    "Start durable guided-development state for a new software goal. Use this when the user wants development guidance or does not know the next step; classify session_span and route_clarity from the conversation/repository. Existing state is protected unless replace=true, and first-use setup plus deterministic routing are enforced.",
    {
      repo_path: z.string().min(1),
      goal: z.string().min(1),
      session_span: z.enum(["single", "multi", "unknown"]).optional(),
      route_clarity: z.enum(["clear", "foggy", "unknown"]).optional(),
      decisions_settled: z.boolean().optional(),
      replace: z.boolean().optional(),
    },
    safe(async ({
      repo_path,
      goal,
      session_span,
      route_clarity,
      decisions_settled,
      replace,
    }) =>
      toolResult(
        await workflowService.start({
          repoPath: repo_path,
          goal,
          sessionSpan: session_span,
          routeClarity: route_clarity,
          decisionsSettled: decisions_settled,
          replace,
        }),
      )),
  );

  registerTool(
    server,
    "workflow.list",
    "List durable guided-development workflows so the assistant can recover active projects across chats before asking the user to repeat context.",
    {
      include_done: z.boolean().optional(),
    },
    safe(async ({ include_done }) =>
      toolResult(
        await workflowService.list({
          includeDone: include_done,
        }),
      ),
    ),
  );

  registerTool(
    server,
    "workflow.status",
    "Read the current durable guided-development state and recommended skill without advancing the workflow or executing the skill.",
    {
      repo_path: z.string().min(1),
    },
    safe(async ({ repo_path }) =>
      toolResult(await workflowService.status({ repoPath: repo_path })),
    ),
  );

  registerTool(
    server,
    "workflow.update",
    "Persist progress inside the current guided-development phase without crossing a phase boundary. Use it to keep open decisions, routing observations, and artifact paths durable across chats.",
    {
      repo_path: z.string().min(1),
      session_span: z.enum(["single", "multi", "unknown"]).optional(),
      route_clarity: z.enum(["clear", "foggy", "unknown"]).optional(),
      open_decisions: z.array(z.string()).optional(),
      artifacts: z.record(z.string(), z.string()).optional(),
      implementation_task_ids: z.array(z.string().min(1)).optional(),
      review_evidence: z.object({
        target_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        standards: z.object({ result: z.enum(["PASS", "FAIL"]), blocking_findings: z.number().int().min(0) }),
        spec: z.object({ result: z.enum(["PASS", "FAIL"]), blocking_findings: z.number().int().min(0) }),
        note: z.string().optional(),
      }).optional(),
      note: z.string().optional(),
    },
    safe(async ({
      repo_path,
      session_span,
      route_clarity,
      open_decisions,
      artifacts,
      implementation_task_ids,
      review_evidence,
      note,
    }) =>
      toolResult(
        await workflowService.update({
          repoPath: repo_path,
          sessionSpan: session_span,
          routeClarity: route_clarity,
          openDecisions: open_decisions,
          artifacts,
          implementationTaskIds: implementation_task_ids,
          reviewEvidence: review_evidence,
          note,
        }),
      )),
  );

  registerTool(
    server,
    "workflow.guide",
    "Read durable guided-development state and recommend the next workflow skill without executing it. Use this whenever the user says continue, asks what to do next, or says they do not know the next development step. After receiving the recommendation, call skill.invoke with that Skill and the user's current request so the chat model follows the installed Matt instructions under AgentDock's invocation policy.",
    {
      repo_path: z.string().min(1),
    },
    safe(async ({ repo_path }) =>
      toolResult(await workflowService.guide({ repoPath: repo_path })),
    ),
  );

  registerTool(
    server,
    "workflow.advance",
    "Advance guided-development state only after the recommended skill has actually reached an explicit phase boundary. Never use this to skip unresolved decisions; invalid jumps fail closed and the durable history records the transition.",
    {
      repo_path: z.string().min(1),
      event: z.enum([
        "setup_complete",
        "grilling_complete",
        "prototype_needed",
        "prototype_complete",
        "map_clear",
        "spec_complete",
        "tickets_complete",
        "implementation_complete",
        "review_passed",
        "review_changes_requested",
        "blocked",
        "resume",
      ]),
      session_span: z.enum(["single", "multi", "unknown"]).optional(),
      route_clarity: z.enum(["clear", "foggy", "unknown"]).optional(),
      open_decisions: z.array(z.string()).optional(),
      note: z.string().optional(),
    },
    safe(async ({
      repo_path,
      event,
      session_span,
      route_clarity,
      open_decisions,
      note,
    }) =>
      toolResult(
        await workflowService.advance({
          repoPath: repo_path,
          event,
          sessionSpan: session_span,
          routeClarity: route_clarity,
          openDecisions: open_decisions,
          note,
        }),
      )),
  );

  return { server, runtime: services };
}
