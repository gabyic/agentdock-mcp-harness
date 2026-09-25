import { createHash } from "node:crypto";
import { AgentDockError } from "./errors.js";

const ACTIVE_PROCESS_STATUSES = new Set(["RUNNING", "CANCELLING"]);
const OPEN_PLAN_STATUSES = new Set([
  "RUNNING",
  "AWAITING_ASSISTANT",
  "AWAITING_APPROVAL",
  "AWAITING_USER",
]);

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function terminalTimestamp(task) {
  return task.status === "CANCELLED"
    ? task.cancelled_at ?? task.updated_at
    : task.finished_at ?? task.updated_at;
}

function errorRecord(taskId, error) {
  return {
    task_id: taskId,
    reason: "FINALIZED_INSPECTION_FAILED",
    error_code: error?.code ?? null,
    message: error?.message ?? String(error),
  };
}

export class TaskReconcileService {
  #tasks;
  #store;
  #hygiene;
  #git;
  #audit;

  constructor({ taskService, stateStore, taskHygieneService, gitService, auditService }) {
    this.#tasks = taskService;
    this.#store = stateStore;
    this.#hygiene = taskHygieneService;
    this.#git = gitService;
    this.#audit = auditService;
  }

  #appendAuditBestEffort(taskId, entry) {
    if (!this.#audit) {
      return { audit_recorded: false };
    }
    try {
      this.#audit.append(taskId, entry);
      return { audit_recorded: true };
    } catch (error) {
      return {
        audit_recorded: false,
        audit_error_code: error?.code ?? null,
        audit_error: error?.message ?? String(error),
      };
    }
  }

  async preview({ staleAfterSeconds = 3600 } = {}) {
    const listing = await this.#hygiene.list({ staleAfterSeconds, includeFinalized: true });
    const processMetadata = this.#store.listProcessMetadata();
    const planDocuments = this.#store.listDocuments("plan").map((document) => document.value);
    const candidates = [];
    const blocked = [];
    const needsAttention = [];

    for (const summary of listing.tasks) {
      if (summary.status === "ACTIVE") {
        if (summary.stale) {
          const runStartPending = summary.blockers.some(
            (blocker) => blocker.code === "RUN_START_PENDING",
          );
          needsAttention.push({
            task_id: summary.task_id,
            disposition: "NEEDS_ATTENTION",
            reason: runStartPending
              ? "RUN_START_PENDING_REVIEW_REQUIRED"
              : "ACTIVE_STALE_REVIEW_REQUIRED",
            age_seconds: summary.age_seconds,
            blockers: summary.blockers,
            worktree_bytes: summary.worktree_bytes,
          });
        }
        continue;
      }

      const task = this.#tasks.get(summary.task_id);
      if (task.workspace_cleaned) {
        if (summary.worktree_present) {
          blocked.push({
            task_id: task.task_id,
            reason: "CLEANUP_STATE_MISMATCH",
            message: "Task is marked cleaned but its worktree path still exists.",
            worktree_bytes: summary.worktree_bytes,
          });
        }
        continue;
      }

      if (summary.worktree_inspection_error) {
        blocked.push({
          task_id: task.task_id,
          reason: "WORKTREE_INSPECTION_FAILED",
          message: summary.worktree_inspection_error,
        });
        continue;
      }
      if (!summary.worktree_present) {
        blocked.push({ task_id: task.task_id, reason: "WORKTREE_MISSING_STATE_MISMATCH" });
        continue;
      }

      const finalizedAt = Date.parse(terminalTimestamp(task) ?? "");
      if (!Number.isFinite(finalizedAt)) {
        blocked.push({ task_id: task.task_id, reason: "FINALIZED_TIMESTAMP_INVALID" });
        continue;
      }
      const finalizedAgeSeconds = Math.max(0, Math.floor((Date.now() - finalizedAt) / 1000));
      if (finalizedAgeSeconds < staleAfterSeconds) {
        blocked.push({
          task_id: task.task_id,
          reason: "RETENTION_WINDOW_OPEN",
          finalized_age_seconds: finalizedAgeSeconds,
          minimum_finalized_age_seconds: staleAfterSeconds,
        });
        continue;
      }

      const pendingStarts = summary.pending_process_starts ?? [];
      if (pendingStarts.length > 0) {
        blocked.push({
          task_id: task.task_id,
          reason: "RUN_START_PENDING",
          process_ids: pendingStarts.map((entry) => entry.process_id),
          reservations: pendingStarts,
        });
        continue;
      }
      const active = processMetadata.filter(
        (process) => process.task_id === task.task_id && ACTIVE_PROCESS_STATUSES.has(process.status),
      );
      if (active.length > 0) {
        blocked.push({ task_id: task.task_id, reason: "ACTIVE_RUNS", run_ids: active.map((run) => run.process_id) });
        continue;
      }
      const openPlans = planDocuments.filter(
        (plan) => plan?.task_id === task.task_id && OPEN_PLAN_STATUSES.has(plan.status),
      );
      if (openPlans.length > 0) {
        blocked.push({ task_id: task.task_id, reason: "OPEN_PLANS", plan_ids: openPlans.map((plan) => plan.plan_id) });
        continue;
      }
      const pendingApprovals = (task.approvals ?? []).filter((approval) =>
        ["PENDING", "AWAITING_USER"].includes(approval.status));
      if (pendingApprovals.length > 0) {
        blocked.push({
          task_id: task.task_id,
          reason: "PENDING_APPROVALS",
          approval_ids: pendingApprovals.map((approval) => approval.approval_id),
        });
        continue;
      }

      let policy;
      let expectedHead;
      let requiresRetention = false;
      if (task.status === "CANCELLED") {
        policy = "CANCELLED_CLEAN_AFTER_RETENTION_WINDOW";
        expectedHead = task.base_head;
      } else if (task.status === "COMPLETED") {
        const finalCommit = task.final_commit_sha ?? null;
        if (task.outcome === "COMMIT") {
          if (!finalCommit || finalCommit === task.base_head) {
            blocked.push({ task_id: task.task_id, reason: "COMMIT_OUTCOME_INVALID", final_commit_sha: finalCommit });
            continue;
          }
          policy = "COMPLETED_COMMIT_RETAINED";
          expectedHead = finalCommit;
          requiresRetention = true;
        } else if (task.outcome === "NO_CHANGE") {
          if (finalCommit !== task.base_head || !String(task.outcome_reason ?? "").trim() || task.retention_ref) {
            blocked.push({ task_id: task.task_id, reason: "NO_CHANGE_OUTCOME_INVALID", final_commit_sha: finalCommit });
            continue;
          }
          policy = "COMPLETED_NO_CHANGE_AFTER_RETENTION_WINDOW";
          expectedHead = task.base_head;
        } else if (task.outcome == null) {
          if (!finalCommit) {
            blocked.push({ task_id: task.task_id, reason: "LEGACY_FINAL_COMMIT_MISSING" });
            continue;
          }
          expectedHead = finalCommit;
          if (finalCommit === task.base_head) {
            policy = "LEGACY_NO_CHANGE_AFTER_RETENTION_WINDOW";
          } else {
            policy = "LEGACY_COMMIT_RETAINED";
            requiresRetention = true;
          }
        } else {
          blocked.push({ task_id: task.task_id, reason: "COMPLETION_OUTCOME_UNKNOWN", outcome: task.outcome });
          continue;
        }
      } else {
        blocked.push({ task_id: task.task_id, reason: "TASK_STATUS_UNSUPPORTED", status: task.status });
        continue;
      }

      try {
        await this.#tasks.assertGcWorktreePath(task);
        await this.#git.assertRegisteredWorktree({
          repoRoot: task.source_repo,
          worktreePath: task.worktree_path,
        });
        const diff = await this.#git.diff(task.worktree_path);
        if (diff.changed_files.length > 0) {
          blocked.push({
            task_id: task.task_id,
            reason: task.status === "CANCELLED" ? "CANCELLED_WORKTREE_DIRTY" : "FINALIZED_WORKTREE_DIRTY",
            changed_files: diff.changed_files,
            worktree_bytes: summary.worktree_bytes,
          });
          continue;
        }
        const head = await this.#git.currentHead(task.worktree_path);
        if (head !== expectedHead) {
          blocked.push({
            task_id: task.task_id,
            reason: "FINALIZED_HEAD_MISMATCH",
            expected_head: expectedHead,
            actual_head: head,
            worktree_bytes: summary.worktree_bytes,
          });
          continue;
        }
        if (requiresRetention) {
          const canonicalRef = this.#git.taskRetentionRef(task.task_id);
          if (task.retention_ref !== canonicalRef) {
            blocked.push({
              task_id: task.task_id,
              reason: "COMMIT_RETENTION_NONCANONICAL",
              expected_ref: canonicalRef,
              actual_ref: task.retention_ref ?? null,
            });
            continue;
          }
          await this.#git.assertRetainedTaskCommit({
            repoRoot: task.source_repo,
            ref: task.retention_ref,
            commitSha: task.final_commit_sha,
          });
        }
      } catch (error) {
        if (error?.code === "TASK_COMMIT_NOT_RETAINED") {
          blocked.push({ task_id: task.task_id, reason: "COMMIT_RETENTION_INVALID", error_code: error.code });
        } else if (error?.code === "TASK_WORKTREE_NOT_REGISTERED") {
          blocked.push({ task_id: task.task_id, reason: "WORKTREE_NOT_REGISTERED", ...(error.details ?? {}) });
        } else if (["TASK_GC_WORKTREE_PATH_UNSAFE", "TASK_GC_WORKTREE_MISSING"].includes(error?.code)) {
          blocked.push({ task_id: task.task_id, reason: "WORKTREE_PATH_UNSAFE", error_code: error.code, ...(error.details ?? {}) });
        } else {
          blocked.push(errorRecord(task.task_id, error));
        }
        continue;
      }

      candidates.push({
        task_id: task.task_id,
        status: task.status,
        outcome: task.outcome ?? null,
        updated_at: task.updated_at,
        finalized_at: terminalTimestamp(task),
        final_commit_sha: task.final_commit_sha ?? null,
        retention_ref: task.retention_ref ?? null,
        worktree_present: summary.worktree_present,
        reclaimable_bytes: summary.worktree_bytes,
        policy,
      });
    }

    candidates.sort((left, right) => left.task_id.localeCompare(right.task_id));
    blocked.sort((left, right) => left.task_id.localeCompare(right.task_id));
    needsAttention.sort((left, right) => left.task_id.localeCompare(right.task_id));
    const tokenPayload = { stale_after_seconds: staleAfterSeconds, candidates };
    return {
      reconcile_token: fingerprint(tokenPayload),
      generated_at: new Date().toISOString(),
      stale_after_seconds: staleAfterSeconds,
      minimum_finalized_age_seconds: staleAfterSeconds,
      candidate_count: candidates.length,
      reclaimable_bytes: candidates.reduce((total, candidate) => total + candidate.reclaimable_bytes, 0),
      blocked_count: blocked.length,
      needs_attention_count: needsAttention.length,
      orphan_worktree_count: listing.storage.orphan_worktree_count,
      orphan_worktree_bytes: listing.storage.orphan_worktree_bytes,
      candidates,
      blocked,
      needs_attention: needsAttention,
    };
  }

  async gc({ reconcileToken, taskIds, staleAfterSeconds = 3600 }) {
    const preview = await this.preview({ staleAfterSeconds });
    if (preview.reconcile_token !== reconcileToken) {
      throw new AgentDockError(
        "RECONCILE_SNAPSHOT_CHANGED",
        "Reconciliation state changed; run task.reconcile again before GC.",
        { expected_token: reconcileToken, actual_token: preview.reconcile_token },
      );
    }
    const requested = [...new Set(taskIds)];
    if (requested.length === 0) {
      throw new AgentDockError("GC_TASKS_REQUIRED", "task.gc requires at least one explicit task_id.");
    }
    const eligible = new Map(preview.candidates.map((candidate) => [candidate.task_id, candidate]));
    for (const taskId of requested) {
      if (!eligible.has(taskId)) {
        throw new AgentDockError("GC_TASK_NOT_ELIGIBLE", "Task is not eligible in the supplied reconciliation snapshot.", { task_id: taskId });
      }
    }

    const results = [];
    for (const taskId of requested) {
      const candidate = eligible.get(taskId);
      let task;
      try {
        const active = this.#store.listProcessMetadata().filter(
          (process) => process.task_id === taskId && ACTIVE_PROCESS_STATUSES.has(process.status),
        );
        if (active.length > 0) {
          throw new AgentDockError("TASK_PROCESSES_ACTIVE", "Task became active before GC.", { task_id: taskId });
        }
        const before = this.#tasks.get(taskId);
        if (before.workspace_cleaned) {
          results.push({ task_id: taskId, disposition: "ALREADY_CLEANED", reclaimed_bytes_estimate: 0 });
          continue;
        }
        task = await this.#tasks.cleanup(taskId, { requireClean: true });
      } catch (error) {
        const audit = this.#appendAuditBestEffort(taskId, {
          event: "TASK_GC_FAILED",
          reconcile_token: reconcileToken,
          policy: candidate.policy,
          error_code: error?.code ?? null,
          message: error?.message ?? String(error),
        });
        results.push({
          task_id: taskId,
          disposition: "FAILED",
          error_code: error?.code ?? null,
          message: error?.message ?? String(error),
          reclaimed_bytes_estimate: 0,
          ...audit,
        });
        continue;
      }

      const audit = this.#appendAuditBestEffort(taskId, {
        event: "TASK_GC_CLEANED",
        reconcile_token: reconcileToken,
        policy: candidate.policy,
        reclaimed_bytes_estimate: candidate.reclaimable_bytes,
        gc_safety_ref: task.gc_safety_ref,
        cleaned_at: task.cleaned_at,
      });
      results.push({
        task_id: taskId,
        disposition: "CLEANED",
        status: task.status,
        cleaned_at: task.cleaned_at,
        gc_safety_ref: task.gc_safety_ref,
        reclaimed_bytes_estimate: candidate.reclaimable_bytes,
        ...audit,
      });
    }
    const cleaned = results.filter((item) => item.disposition === "CLEANED");
    return {
      reconcile_token: reconcileToken,
      requested_count: requested.length,
      cleaned_count: cleaned.length,
      failed_count: results.filter((item) => item.disposition === "FAILED").length,
      reclaimed_bytes_estimate: cleaned.reduce((total, item) => total + item.reclaimed_bytes_estimate, 0),
      results,
      cleaned,
    };
  }
}
