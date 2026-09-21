import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AgentDockError } from "./errors.js";

export class TaskService {
  #git;
  #store;
  #tasks = new Map();

  constructor({ gitService, stateStore }) {
    this.#git = gitService;
    this.#store = stateStore;
  }

  get(taskId) {
    if (!/^task_[0-9a-f-]{36}$/.test(taskId)) {
      throw new AgentDockError("INVALID_TASK_ID", "Invalid task_id format.");
    }

    let task = this.#tasks.get(taskId);
    if (!task) {
      task = this.#store.loadTask(taskId);
      if (task) {
        this.#tasks.set(taskId, task);
      }
    }

    if (!task) {
      throw new AgentDockError("TASK_NOT_FOUND", "Task not found: " + taskId);
    }
    return task;
  }

  resume(taskId) {
    const task = this.get(taskId);
    if (!existsSync(task.worktree_path)) {
      throw new AgentDockError(
        "TASK_WORKTREE_MISSING",
        "Task worktree no longer exists: " + task.worktree_path,
      );
    }
    return task;
  }

  addProcess(taskId, processId) {
    const task = this.get(taskId);
    task.process_ids ??= [];
    if (!task.process_ids.includes(processId)) {
      task.process_ids.push(processId);
      task.updated_at = new Date().toISOString();
      this.#store.saveTask(task);
    }
    return task;
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
      created_at: now,
      updated_at: now,
    };

    this.#tasks.set(taskId, task);
    this.#store.saveTask(task);
    return task;
  }
}
