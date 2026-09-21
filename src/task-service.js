import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class TaskService {
  #git;
  #tasks = new Map();
  #stateDir;

  constructor({ gitService, stateDir }) {
    this.#git = gitService;
    this.#stateDir =
      stateDir ??
      process.env.AGENTDOCK_STATE_DIR ??
      path.join(os.homedir(), ".local", "state", "agentdock");
  }

  async create({ repoPath }) {
    const source = await this.#git.inspect(repoPath);
    const taskId = `task_${randomUUID()}`;
    const worktreesDir = path.join(this.#stateDir, "worktrees");
    const worktreePath = path.join(worktreesDir, taskId);

    await mkdir(worktreesDir, { recursive: true });

    const worktree = await this.#git.createDetachedWorktree({
      repoRoot: source.repo_root,
      baseHead: source.head,
      worktreePath,
    });

    const task = {
      task_id: taskId,
      status: "ACTIVE",
      source_repo: source.repo_root,
      base_head: source.head,
      worktree_path: worktreePath,
      worktree_clean: worktree.clean,
      source_dirty: source.source_dirty,
      uncommitted_changes_not_included: source.source_dirty,
      created_at: new Date().toISOString(),
    };

    this.#tasks.set(taskId, task);
    return task;
  }
}
