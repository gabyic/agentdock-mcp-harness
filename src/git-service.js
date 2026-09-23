import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { AgentDockError } from "./errors.js";

const execFileAsync = promisify(execFile);

export class GitService {
  async #git(cwd, args) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, ...args],
        {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      return stdout.trimEnd();
    } catch (error) {
      const detail =
        typeof error?.stderr === "string" && error.stderr.trim()
          ? error.stderr.trim()
          : error?.message ?? String(error);
      throw new Error("git " + args.join(" ") + " failed in " + cwd + ": " + detail);
    }
  }

  async #gitDiffNoIndex(cwd, relativePath) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "diff", "--no-index", "--", "/dev/null", relativePath],
        {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      return stdout.trimEnd();
    } catch (error) {
      if (error?.code === 1 && typeof error?.stdout === "string") {
        return error.stdout.trimEnd();
      }
      const detail =
        typeof error?.stderr === "string" && error.stderr.trim()
          ? error.stderr.trim()
          : error?.message ?? String(error);
      throw new Error("git diff --no-index failed for " + relativePath + ": " + detail);
    }
  }

  async inspect(path) {
    const repoRootRaw = await this.#git(path, ["rev-parse", "--show-toplevel"]);
    const repoRoot = await realpath(repoRootRaw);
    const head = await this.#git(repoRoot, ["rev-parse", "HEAD"]);
    const porcelain = await this.#git(repoRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    return {
      repo_root: repoRoot,
      head,
      source_dirty: porcelain.length > 0,
      status_porcelain: porcelain ? porcelain.split("\n") : [],
    };
  }

  async currentHead(worktreePath) {
    return this.#git(worktreePath, ["rev-parse", "HEAD"]);
  }

  taskRetentionRef(taskId) {
    return "refs/agentdock/tasks/" + taskId;
  }

  async retainTaskCommit({ repoRoot, taskId, commitSha }) {
    const ref = this.taskRetentionRef(taskId);
    await this.#git(repoRoot, ["update-ref", ref, commitSha]);
    const target = await this.#git(repoRoot, ["rev-parse", ref]);
    if (target != commitSha) {
      throw new AgentDockError(
        "TASK_COMMIT_RETENTION_FAILED",
        "AgentDock could not anchor the Task commit under its durable ref.",
        { ref, expected_commit_sha: commitSha, actual_commit_sha: target },
      );
    }
    return ref;
  }

  async assertRetainedTaskCommit({ repoRoot, ref, commitSha }) {
    let target;
    try {
      target = await this.#git(repoRoot, ["rev-parse", ref]);
    } catch (error) {
      throw new AgentDockError(
        "TASK_COMMIT_NOT_RETAINED",
        "Task cleanup refused because its durable Git ref is missing.",
        { ref, commit_sha: commitSha },
      );
    }
    if (target != commitSha) {
      throw new AgentDockError(
        "TASK_COMMIT_NOT_RETAINED",
        "Task cleanup refused because its durable Git ref no longer points at the final commit.",
        { ref, expected_commit_sha: commitSha, actual_commit_sha: target },
      );
    }
    return { ref, commit_sha: target };
  }

  async createDetachedWorktree({ repoRoot, baseHead, worktreePath }) {
    await this.#git(repoRoot, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      baseHead,
    ]);

    const worktreeHead = await this.#git(worktreePath, ["rev-parse", "HEAD"]);
    const worktreeStatus = await this.#git(worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    if (worktreeHead !== baseHead) {
      throw new Error(
        "Worktree HEAD mismatch: expected " + baseHead + ", got " + worktreeHead,
      );
    }

    if (worktreeStatus.length > 0) {
      throw new Error(
        "New worktree is not clean: " + worktreeStatus.replaceAll("\n", " | "),
      );
    }

    return { head: worktreeHead, clean: true };
  }

  async diff(worktreePath) {
    const porcelain = await this.#git(worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const statusLines = porcelain ? porcelain.split("\n") : [];
    const changedFiles = statusLines.map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3),
    }));
    const trackedPatch = await this.#git(worktreePath, [
      "diff",
      "--no-ext-diff",
      "--binary",
      "HEAD",
      "--",
      ".",
    ]);

    const untracked = changedFiles.filter((entry) => entry.status === "??");
    const untrackedPatches = [];
    for (const entry of untracked) {
      untrackedPatches.push(await this.#gitDiffNoIndex(worktreePath, entry.path));
    }

    return {
      changed_files: changedFiles,
      patch: [trackedPatch, ...untrackedPatches].filter(Boolean).join("\n"),
    };
  }

  async commit(worktreePath, { message }) {
    const before = await this.diff(worktreePath);
    if (before.changed_files.length === 0) {
      throw new AgentDockError(
        "GIT_NOTHING_TO_COMMIT",
        "Task worktree has no changes to commit.",
      );
    }

    await this.#git(worktreePath, ["add", "-A"]);
    await this.#git(worktreePath, [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ]);

    const commitSha = await this.currentHead(worktreePath);
    const after = await this.diff(worktreePath);
    if (after.changed_files.length !== 0) {
      throw new AgentDockError(
        "GIT_COMMIT_LEFT_DIRTY",
        "Commit succeeded but Task worktree is still dirty.",
        { changed_files: after.changed_files },
      );
    }

    return {
      commit_sha: commitSha,
      message,
      committed_files: before.changed_files,
      worktree_clean: true,
    };
  }

  async removeWorktree({ repoRoot, worktreePath }) {
    await this.#git(repoRoot, [
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    await this.#git(repoRoot, ["worktree", "prune"]);
    return {
      removed: true,
      worktree_path: worktreePath,
    };
  }
}
