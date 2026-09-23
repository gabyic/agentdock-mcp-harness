import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AgentDockError } from "./errors.js";

export class TaskService {
  #git;
  #store;

  constructor({ gitService, stateStore }) {
    this.#git = gitService;
    this.#store = stateStore;
  }

  #validateTaskId(taskId) {
    if (!/^task_[0-9a-f-]{36}$/.test(taskId)) {
      throw new AgentDockError("INVALID_TASK_ID", "Invalid task_id format.");
    }
    return taskId;
  }

  #assertExists(task, taskId) {
    if (!task) {
      throw new AgentDockError("TASK_NOT_FOUND", "Task not found: " + taskId);
    }
    return task;
  }

  #assertActiveRecord(task) {
    if (task.status !== "ACTIVE") {
      throw new AgentDockError(
        "TASK_NOT_ACTIVE",
        "Task is not ACTIVE: " + task.status,
        { status: task.status },
      );
    }
    if (task.workspace_cleaned) {
      throw new AgentDockError(
        "TASK_WORKSPACE_CLEANED",
        "Task workspace has already been cleaned up.",
      );
    }
    return task;
  }

  get(taskId) {
    this.#validateTaskId(taskId);
    return this.#assertExists(this.#store.loadTask(taskId), taskId);
  }

  save(task) {
    this.#validateTaskId(task.task_id);
    this.#store.saveTask(task);
    return task;
  }

  mutate(taskId, mutator) {
    this.#validateTaskId(taskId);
    let result;
    const task = this.#store.mutateTask(taskId, (current) => {
      this.#assertExists(current, taskId);
      result = mutator(current);
      return current;
    });
    return { task, result };
  }

  assertActive(taskId) {
    return this.#assertActiveRecord(this.get(taskId));
  }

  resume(taskId) {
    const task = this.get(taskId);
    if (task.workspace_cleaned) {
      throw new AgentDockError(
        "TASK_WORKSPACE_CLEANED",
        "Task workspace has already been cleaned up.",
      );
    }
    if (!existsSync(task.worktree_path)) {
      throw new AgentDockError(
        "TASK_WORKTREE_MISSING",
        "Task worktree no longer exists: " + task.worktree_path,
      );
    }
    return task;
  }

  addProcess(taskId, processId) {
    return this.mutate(taskId, (task) => {
      this.#assertActiveRecord(task);
      task.process_ids ??= [];
      if (!task.process_ids.includes(processId)) {
        task.process_ids.push(processId);
        task.updated_at = new Date().toISOString();
      }
    }).task;
  }

  finish(
    taskId,
    {
      finalCommitSha,
      outcome,
      outcomeReason = null,
      retentionRef = null,
    },
  ) {
    return this.mutate(taskId, (task) => {
      this.#assertActiveRecord(task);
      const now = new Date().toISOString();
      task.status = "COMPLETED";
      task.final_commit_sha = finalCommitSha;
      task.outcome = outcome;
      task.outcome_reason = outcomeReason;
      task.retention_ref = retentionRef;
      task.finished_at = now;
      task.updated_at = now;
      task.approval_grants = [];
    }).task;
  }

  cancel(taskId) {
    return this.mutate(taskId, (task) => {
      if (task.status === "CANCELLED") {
        return;
      }
      if (task.status !== "ACTIVE") {
        throw new AgentDockError(
          "TASK_NOT_ACTIVE",
          "Only an ACTIVE Task can be cancelled.",
          { status: task.status },
        );
      }

      const now = new Date().toISOString();
      task.status = "CANCELLED";
      task.cancelled_at = now;
      task.updated_at = now;
      task.approval_grants = [];
    }).task;
  }

  async cleanup(taskId) {
    const task = this.get(taskId);
    if (task.workspace_cleaned) {
      return task;
    }
    if (task.status !== "COMPLETED" && task.status !== "CANCELLED") {
      throw new AgentDockError(
        "TASK_NOT_FINALIZED",
        "Task must be COMPLETED or CANCELLED before cleanup.",
        { status: task.status },
      );
    }

    if (task.status === "COMPLETED" && task.outcome === "COMMIT") {
      if (!task.retention_ref || !task.final_commit_sha) {
        throw new AgentDockError(
          "TASK_COMMIT_NOT_RETAINED",
          "Task cleanup refused because completed commit evidence is incomplete.",
          {
            retention_ref: task.retention_ref ?? null,
            final_commit_sha: task.final_commit_sha ?? null,
          },
        );
      }
      await this.#git.assertRetainedTaskCommit({
        repoRoot: task.source_repo,
        ref: task.retention_ref,
        commitSha: task.final_commit_sha,
      });
    }

    if (existsSync(task.worktree_path)) {
      await this.#git.removeWorktree({
        repoRoot: task.source_repo,
        worktreePath: task.worktree_path,
      });
    }

    return this.mutate(taskId, (current) => {
      if (current.workspace_cleaned) return;
      if (
        current.status !== "COMPLETED" &&
        current.status !== "CANCELLED"
      ) {
        throw new AgentDockError(
          "TASK_NOT_FINALIZED",
          "Task changed state before cleanup could be recorded.",
          { status: current.status },
        );
      }
      const now = new Date().toISOString();
      current.workspace_cleaned = true;
      current.cleaned_at = now;
      current.updated_at = now;
    }).task;
  }

  async create({ repoPath }) {
    const source = await this.#git.inspect(repoPath);
    const taskId = "task_" + randomUUID();
    const worktreesDir = path.join(this.#store.stateDir, "worktrees");
    const worktreePath = path.join(worktreesDir, taskId);

    await mkdir(worktreesDir, { recursive: true, mode: 0o700 });

    const worktree = await this.#git.createDetachedWorktree({
      repoRoot: source.repo_root,
      baseHead: source.head,
      worktreePath,
    });

    const now = new Date().toISOString();
    const task = {
      task_id: taskId,
      status: "ACTIVE",
      source_repo: source.repo_root,
      base_head: source.head,
      worktree_path: worktreePath,
      worktree_clean: worktree.clean,
      source_dirty: source.source_dirty,
      uncommitted_changes_not_included: source.source_dirty,
      process_ids: [],
      approvals: [],
      approval_grants: [],
      final_commit_sha: null,
      outcome: null,
      outcome_reason: null,
      retention_ref: null,
      workspace_cleaned: false,
      created_at: now,
      updated_at: now,
    };

    this.#store.saveTask(task);
    return task;
  }
}
