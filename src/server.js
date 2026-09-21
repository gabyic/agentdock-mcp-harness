import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { AgentDockError } from "./errors.js";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { FileEditService } from "./file-edit-service.js";
import { FileQueryService } from "./file-query-service.js";
import { GitService } from "./git-service.js";
import { PolicyService } from "./policy-service.js";
import { ProcessService } from "./process-service.js";
import { StateStore } from "./state-store.js";
import { TaskService } from "./task-service.js";

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
  const annotations = hasAnnotations ? annotationsOrHandler : undefined;

  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object(inputShape),
      ...(annotations ? { annotations } : {}),
    },
    handler,
  );
}

export function createAgentDockServer({ stateDir } = {}) {
  const stateStore = new StateStore({ stateDir });
  const auditService = new AuditService({ stateStore });
  const gitService = new GitService();
  const taskService = new TaskService({ gitService, stateStore });
  const policyService = new PolicyService();
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
  const processService = new ProcessService({
    taskService,
    stateStore,
    approvalService,
    auditService,
  });

  const server = new McpServer(
    { name: "AgentDock", version: "0.2.0-dev.1" },
    { capabilities: { tools: {} } },
  );

  registerTool(
    server,
    "repo.inspect",
    "Inspect a local Git repository without modifying its working tree.",
    { path: z.string().min(1).describe("Path inside the Git repository") },
    { readOnlyHint: true },
    safe(async ({ path }) => toolResult(await gitService.inspect(path))),
  );

  registerTool(
    server,
    "task.create",
    "Create an ACTIVE coding task in a clean detached Git worktree based on source HEAD.",
    {
      repo_path: z.string().min(1).describe("Path inside the source Git repository"),
    },
    safe(async ({ repo_path }) => {
      const task = await taskService.create({ repoPath: repo_path });
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
    "task.resume",
    "Resume a durable Task by task_id and return restored process metadata.",
    { task_id: z.string().min(1) },
    { readOnlyHint: true },
    safe(async ({ task_id }) => {
      const task = taskService.resume(task_id);
      const processes = processService.summariesForTask(task_id);
      auditService.append(task_id, {
        event: "TASK_RESUMED",
        status: task.status,
        worktree_path: task.worktree_path,
        process_count: processes.length,
      });
      return toolResult({
        ...task,
        processes,
      });
    }),
  );

  registerTool(
    server,
    "task.finish",
    "Explicitly mark an ACTIVE Task COMPLETED after processes stop and the worktree is committed.",
    { task_id: z.string().min(1) },
    { destructiveHint: true },
    safe(async ({ task_id }) => {
      const task = taskService.assertActive(task_id);
      const active = processService.activeForTask(task_id);
      if (active.length > 0) {
        throw new AgentDockError(
          "TASK_PROCESSES_ACTIVE",
          "Task still has running or cancelling processes.",
          { processes: active },
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
      const finished = taskService.finish(task_id, { finalCommitSha });
      auditService.append(task_id, {
        event: "TASK_FINISHED",
        status: finished.status,
        final_commit_sha: finished.final_commit_sha,
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
    { destructiveHint: true },
    safe(async ({ task_id }) => {
      taskService.assertActive(task_id);
      const cancelledProcesses = processService.cancelAllForTask(task_id);
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
    { destructiveHint: true },
    safe(async ({ task_id }) => {
      const active = processService.activeForTask(task_id);
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
    { readOnlyHint: true },
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
    { readOnlyHint: true },
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
    { readOnlyHint: true },
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
    { destructiveHint: true },
    safe(async ({ task_id, message }) => {
      const task = taskService.assertActive(task_id);
      const result = await gitService.commit(task.worktree_path, { message });
      task.latest_commit_sha = result.commit_sha;
      task.updated_at = new Date().toISOString();
      taskService.save(task);
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
    { readOnlyHint: true },
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
    { readOnlyHint: true },
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
    },
    safe(async ({ task_id, argv, shell, cwd, env }) =>
      toolResult(
        await processService.start({
          taskId: task_id,
          argv,
          shell,
          cwd,
          env,
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
    { readOnlyHint: true },
    safe(async ({ task_id, process_id }) =>
      toolResult(
        processService.status({ taskId: task_id, processId: process_id }),
      )),
  );

  registerTool(
    server,
    "process.output",
    "Read process stdout/stderr incrementally from a pull cursor.",
    {
      task_id: z.string().min(1),
      process_id: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
    },
    { readOnlyHint: true },
    safe(async ({ task_id, process_id, cursor }) =>
      toolResult(
        processService.output({
          taskId: task_id,
          processId: process_id,
          cursor,
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
    { destructiveHint: true },
    safe(async ({ task_id, process_id }) =>
      toolResult(
        processService.cancel({ taskId: task_id, processId: process_id }),
      )),
  );

  return { server };
}
