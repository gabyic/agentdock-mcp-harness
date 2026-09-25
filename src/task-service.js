import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { AgentDockError } from "./errors.js";
import {
  assertEvidenceKind,
  evaluateCompletionEvidence,
  normalizeCompletionContract,
} from "./completion-evidence.js";

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

  #assertNoPendingProcessStarts(task) {
    const pending = task.pending_process_starts ?? [];
    if (pending.length > 0) {
      throw new AgentDockError(
        "TASK_PROCESS_START_PENDING",
        "Task lifecycle cannot change while a Run start is being registered.",
        { process_ids: pending.map((entry) => entry.process_id) },
      );
    }
  }

  get(taskId) {
    this.#validateTaskId(taskId);
    return this.#assertExists(this.#store.loadTask(taskId), taskId);
  }

  list() {
    return this.#store
      .listDocuments("task")
      .map((document) => document.value)
      .filter(Boolean)
      .sort((left, right) =>
        String(right.created_at ?? "").localeCompare(
          String(left.created_at ?? ""),
        ),
      );
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

  async assertGcWorktreePath(taskOrId) {
    const task = typeof taskOrId === "string" ? this.get(taskOrId) : taskOrId;
    const worktreesRoot = path.join(this.#store.stateDir, "worktrees");
    const expectedPath = path.join(worktreesRoot, task.task_id);
    if (path.resolve(task.worktree_path) !== path.resolve(expectedPath)) {
      throw new AgentDockError(
        "TASK_GC_WORKTREE_PATH_UNSAFE",
        "Automatic GC refuses a worktree path outside the Task worktree root.",
        { expected_path: expectedPath, actual_path: task.worktree_path },
      );
    }

    let targetStat;
    try {
      targetStat = await lstat(task.worktree_path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AgentDockError(
          "TASK_GC_WORKTREE_MISSING",
          "Automatic GC refuses a finalized Task whose worktree is missing.",
          { worktree_path: task.worktree_path },
        );
      }
      throw error;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new AgentDockError(
        "TASK_GC_WORKTREE_PATH_UNSAFE",
        "Automatic GC requires a real Task worktree directory, not a link or file.",
        { worktree_path: task.worktree_path },
      );
    }

    const [realRoot, realTarget] = await Promise.all([
      realpath(worktreesRoot),
      realpath(task.worktree_path),
    ]);
    const expectedRealPath = path.join(realRoot, task.task_id);
    if (realTarget !== expectedRealPath) {
      throw new AgentDockError(
        "TASK_GC_WORKTREE_PATH_UNSAFE",
        "Automatic GC refuses a worktree whose real path does not match its Task identity.",
        { expected_path: expectedRealPath, actual_path: realTarget },
      );
    }
    return { expected_path: expectedPath, real_path: realTarget };
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

  reserveProcessStart(taskId, processId, { ownerInstanceId = null } = {}) {
    if (!/^proc_[0-9a-f-]{36}$/.test(processId)) {
      throw new AgentDockError("INVALID_PROCESS_ID", "Invalid process_id format.");
    }
    if (
      ownerInstanceId !== null &&
      (typeof ownerInstanceId !== "string" || ownerInstanceId.trim().length === 0)
    ) {
      throw new AgentDockError(
        "INVALID_RUNTIME_INSTANCE_ID",
        "owner_instance_id must be a non-empty string when supplied.",
      );
    }
    return this.mutate(taskId, (task) => {
      this.#assertActiveRecord(task);
      task.pending_process_starts ??= [];
      if (!task.pending_process_starts.some((entry) => entry.process_id === processId)) {
        task.pending_process_starts.push({
          process_id: processId,
          owner_instance_id: ownerInstanceId,
          reserved_at: new Date().toISOString(),
        });
      }
      task.updated_at = new Date().toISOString();
    }).task;
  }

  releaseProcessStart(taskId, processId) {
    return this.mutate(taskId, (task) => {
      task.pending_process_starts = (task.pending_process_starts ?? [])
        .filter((entry) => entry.process_id !== processId);
      task.updated_at = new Date().toISOString();
    }).task;
  }

  addProcess(taskId, processId, { reserved = false } = {}) {
    return this.mutate(taskId, (task) => {
      this.#assertActiveRecord(task);
      if (reserved) {
        const pending = task.pending_process_starts ?? [];
        if (!pending.some((entry) => entry.process_id === processId)) {
          throw new AgentDockError(
            "PROCESS_START_RESERVATION_MISSING",
            "Run start reservation is missing.",
            { process_id: processId },
          );
        }
        task.pending_process_starts = pending.filter(
          (entry) => entry.process_id !== processId,
        );
      }
      task.process_ids ??= [];
      if (!task.process_ids.includes(processId)) {
        task.process_ids.push(processId);
        task.updated_at = new Date().toISOString();
      }
    }).task;
  }

  recordCommit(taskId, commitSha) {
    return this.mutate(taskId, (task) => {
      this.#assertActiveRecord(task);
      task.latest_commit_sha = commitSha;
      task.updated_at = new Date().toISOString();
    }).task;
  }

  recordEvidence(taskId, { kind, status, summary, subjectSha, runId = null, details = null }) {
    return this.mutate(taskId, (task) => {
      this.#assertActiveRecord(task);
      const record = {
        evidence_id: "evidence_" + randomUUID(),
        kind: assertEvidenceKind(kind),
        status,
        summary: String(summary).trim(),
        subject_sha: subjectSha,
        run_id: runId,
        details,
        recorded_at: new Date().toISOString(),
      };
      task.completion_evidence ??= [];
      task.completion_evidence.push(record);
      task.updated_at = record.recorded_at;
      return record;
    });
  }

  completionEvidence(task, subjectSha) {
    return evaluateCompletionEvidence(task, subjectSha);
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
      this.#assertNoPendingProcessStarts(task);
      if (outcome === "COMMIT") {
        if (!finalCommitSha || finalCommitSha === task.base_head) {
          throw new AgentDockError(
            "TASK_COMMIT_REQUIRED",
            "COMMIT outcome requires a final commit newer than base HEAD.",
          );
        }
        const canonicalRef = this.#git.taskRetentionRef(task.task_id);
        if (retentionRef !== canonicalRef) {
          throw new AgentDockError(
            "TASK_COMMIT_NOT_RETAINED",
            "COMMIT outcome requires the canonical AgentDock retention ref.",
            { expected_ref: canonicalRef, actual_ref: retentionRef },
          );
        }
      } else if (outcome === "NO_CHANGE") {
        if (finalCommitSha !== task.base_head) {
          throw new AgentDockError(
            "TASK_NO_CHANGE_HAS_COMMIT",
            "NO_CHANGE cannot record a commit newer than base HEAD.",
          );
        }
        if (!String(outcomeReason ?? "").trim()) {
          throw new AgentDockError(
            "TASK_NO_CHANGE_REASON_REQUIRED",
            "NO_CHANGE requires a non-empty reason/evidence.",
          );
        }
        if (retentionRef) {
          throw new AgentDockError(
            "TASK_COMPLETION_METADATA_INVALID",
            "NO_CHANGE cannot carry a commit retention ref.",
          );
        }
      } else if (outcome != null) {
        throw new AgentDockError(
          "TASK_COMPLETION_METADATA_INVALID",
          "Task completion outcome is unsupported.",
          { outcome },
        );
      }
      const verification = evaluateCompletionEvidence(task, finalCommitSha);
      if (!verification.satisfied) {
        const failed = verification.results.some((result) => result.state === "FAIL");
        throw new AgentDockError(
          failed ? "TASK_COMPLETION_EVIDENCE_FAILED" : "TASK_COMPLETION_EVIDENCE_REQUIRED",
          failed
            ? "A required completion check is known to be failing."
            : "Required completion evidence is missing or targets an older implementation result.",
          { completion: verification },
        );
      }
      const now = new Date().toISOString();
      task.status = "COMPLETED";
      task.final_commit_sha = finalCommitSha;
      task.outcome = outcome;
      task.outcome_reason = outcomeReason;
      task.retention_ref = retentionRef;
      task.verification_status = task.completion_contract ? "VERIFIED" : "NOT_REQUIRED";
      task.verification_evidence = task.completion_contract ? verification : null;
      task.verified_at = task.completion_contract ? now : null;
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
      this.#assertNoPendingProcessStarts(task);
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

  async cleanup(taskId, { requireClean = false } = {}) {
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
    this.#assertNoPendingProcessStarts(task);

    if (task.status === "COMPLETED") {
      const finalCommit = task.final_commit_sha ?? null;
      const looksLikeLegacyCommit = task.outcome == null && finalCommit && finalCommit !== task.base_head;
      const requiresRetention = task.outcome === "COMMIT" || looksLikeLegacyCommit;

      if (task.outcome === "COMMIT" && (!finalCommit || finalCommit === task.base_head)) {
        throw new AgentDockError(
          "TASK_COMPLETION_METADATA_INVALID",
          "COMMIT cleanup requires a final commit newer than the base commit.",
          { outcome: task.outcome, base_head: task.base_head, final_commit_sha: finalCommit },
        );
      }
      if (task.outcome === "NO_CHANGE") {
        if (finalCommit !== task.base_head || !String(task.outcome_reason ?? "").trim() || task.retention_ref) {
          throw new AgentDockError(
            "TASK_COMPLETION_METADATA_INVALID",
            "NO_CHANGE cleanup requires base HEAD and a non-empty outcome reason.",
            { outcome: task.outcome, base_head: task.base_head, final_commit_sha: finalCommit },
          );
        }
      } else if (task.outcome == null) {
        if (!finalCommit) {
          throw new AgentDockError(
            "TASK_COMPLETION_METADATA_INVALID",
            "Legacy completed Task has no final commit identity.",
          );
        }
      } else if (task.outcome !== "COMMIT") {
        throw new AgentDockError(
          "TASK_COMPLETION_METADATA_INVALID",
          "Completed Task has an unsupported outcome.",
          { outcome: task.outcome },
        );
      }

      if (requiresRetention) {
        if (!task.retention_ref || !task.final_commit_sha) {
          throw new AgentDockError(
            "TASK_COMMIT_NOT_RETAINED",
            "Task cleanup refused because completed commit evidence is incomplete.",
            {
              outcome: task.outcome ?? "LEGACY_COMMIT",
              retention_ref: task.retention_ref ?? null,
              final_commit_sha: task.final_commit_sha ?? null,
            },
          );
        }
        const canonicalRef = this.#git.taskRetentionRef(task.task_id);
        if (task.retention_ref !== canonicalRef) {
          throw new AgentDockError(
            "TASK_COMMIT_NOT_RETAINED",
            "Task cleanup requires the canonical AgentDock retention ref.",
            { expected_ref: canonicalRef, actual_ref: task.retention_ref },
          );
        }
        await this.#git.assertRetainedTaskCommit({
          repoRoot: task.source_repo,
          ref: task.retention_ref,
          commitSha: task.final_commit_sha,
        });
      }
    }

    let gcSafetyRef = null;
    let expectedHead = null;
    if (requireClean) {
      await this.assertGcWorktreePath(task);
      await this.#git.assertRegisteredWorktree({
        repoRoot: task.source_repo,
        worktreePath: task.worktree_path,
      });
      const diff = await this.#git.diff(task.worktree_path);
      if (diff.changed_files.length > 0) {
        throw new AgentDockError(
          "TASK_GC_WORKTREE_DIRTY",
          "Automatic GC refuses a finalized Task with worktree changes.",
          { changed_files: diff.changed_files },
        );
      }
      const head = await this.#git.currentHead(task.worktree_path);
      expectedHead = task.status === "CANCELLED"
        ? task.base_head
        : (task.final_commit_sha ?? task.base_head);
      if (head !== expectedHead) {
        throw new AgentDockError(
          "TASK_GC_HEAD_MISMATCH",
          "Automatic GC refuses a finalized Task whose worktree HEAD changed after finalization.",
          { expected_head: expectedHead, actual_head: head },
        );
      }
      gcSafetyRef = await this.#git.retainGcSafetyCommit({
        repoRoot: task.source_repo,
        taskId: task.task_id,
        commitSha: expectedHead,
      });
    }

    if (existsSync(task.worktree_path)) {
      await this.#git.removeWorktree({
        repoRoot: task.source_repo,
        worktreePath: task.worktree_path,
        force: !requireClean,
        prune: !requireClean,
        expectedHead,
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
      current.gc_safety_ref = gcSafetyRef;
      current.cleaned_at = now;
      current.updated_at = now;
    }).task;
  }

  async create({ repoPath, completionContract = null }) {
    const normalizedCompletionContract = normalizeCompletionContract(completionContract);
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
      pending_process_starts: [],
      approvals: [],
      approval_grants: [],
      final_commit_sha: null,
      outcome: null,
      outcome_reason: null,
      retention_ref: null,
      completion_contract: normalizedCompletionContract,
      completion_evidence: [],
      verification_status: "PENDING",
      verification_evidence: null,
      verified_at: null,
      workspace_cleaned: false,
      created_at: now,
      updated_at: now,
    };

    this.#store.saveTask(task);
    return task;
  }
}
