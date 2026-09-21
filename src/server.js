import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentDockError } from "./errors.js";
import { ApprovalService } from "./approval-service.js";
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

export function createAgentDockServer({ stateDir } = {}) {
  const stateStore = new StateStore({ stateDir });
  const gitService = new GitService();
  const taskService = new TaskService({ gitService, stateStore });
  const policyService = new PolicyService();
  const approvalService = new ApprovalService({ taskService, policyService });
  const fileQueryService = new FileQueryService({ taskService });
  const fileEditService = new FileEditService({ taskService });
  const processService = new ProcessService({
    taskService,
    stateStore,
    approvalService,
  });

  const server = new McpServer(
    { name: "AgentDock", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "repo.inspect",
    "Inspect a local Git repository without modifying its working tree.",
    { path: z.string().min(1).describe("Path inside the Git repository") },
    { readOnlyHint: true },
    safe(async ({ path }) => toolResult(await gitService.inspect(path))),
  );

  server.tool(
    "task.create",
    "Create an ACTIVE coding task in a clean detached Git worktree based on source HEAD.",
    {
      repo_path: z.string().min(1).describe("Path inside the source Git repository"),
    },
    safe(async ({ repo_path }) =>
      toolResult(await taskService.create({ repoPath: repo_path }))),
  );

  server.tool(
    "task.resume",
    "Resume a durable Task by task_id and return restored process metadata.",
    { task_id: z.string().min(1) },
    { readOnlyHint: true },
    safe(async ({ task_id }) => {
      const task = taskService.resume(task_id);
      return toolResult({
        ...task,
        processes: processService.summariesForTask(task_id),
      });
    }),
  );

  server.tool(
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
      return toolResult(
        taskService.finish(task_id, { finalCommitSha }),
      );
    }),
  );

  server.tool(
    "task.cancel",
    "Cancel an ACTIVE Task, best-effort stopping its running processes while preserving the worktree.",
    { task_id: z.string().min(1) },
    { destructiveHint: true },
    safe(async ({ task_id }) => {
      taskService.assertActive(task_id);
      const cancelledProcesses = processService.cancelAllForTask(task_id);
      const task = taskService.cancel(task_id);
      return toolResult({
        ...task,
        cancelled_processes: cancelledProcesses,
      });
    }),
  );

  server.tool(
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

      return toolResult(await taskService.cleanup(task_id));
    }),
  );

  server.tool(
    "file.read",
    "Read a UTF-8 file from the Task worktree and return a content hash.",
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

  server.tool(
    "file.search",
    "Search Task worktree files using deterministic text matching and a glob.",
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

  server.tool(
    "file.patch",
    "Patch an existing Task file only if its previously-read SHA-256 still matches.",
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

  server.tool(
    "file.write",
    "Create a new UTF-8 Task file or explicitly replace an existing file.",
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

  server.tool(
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


  server.tool(
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
      return toolResult({
        task_id,
        ...result,
      });
    }),
  );


  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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
