const ACTIVE_RUN_STATUSES = new Set(["RUNNING", "CANCELLING"]);
const PENDING_APPROVAL_STATUSES = new Set(["PENDING", "AWAITING_USER"]);

function completionBlocker(task, completionEvidence) {
  const required = task.completion_contract?.required ?? [];
  if (required.length === 0) return null;
  if (completionEvidence) {
    const blocked = completionEvidence.results.filter((result) => result.state !== "PASS");
    return blocked.length > 0
      ? { kind: "ASSISTANT", code: "TASK_COMPLETION_EVIDENCE_REQUIRED", evidence: blocked }
      : null;
  }
  const records = task.completion_evidence ?? [];
  const blocked = required.filter((kind) => {
    const latest = [...records].reverse().find((record) => record.kind === kind);
    return !latest || latest.status !== "PASS";
  });
  return blocked.length > 0
    ? { kind: "ASSISTANT", code: "TASK_COMPLETION_EVIDENCE_REQUIRED", evidence_kinds: blocked }
    : null;
}

function timestampMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function mostRecentProcess(processes) {
  return [...(processes ?? [])].sort((left, right) => {
    const leftAt = timestampMs(left.ended_at) ?? timestampMs(left.started_at) ?? 0;
    const rightAt = timestampMs(right.ended_at) ?? timestampMs(right.started_at) ?? 0;
    return rightAt - leftAt;
  })[0] ?? null;
}

function pendingApprovals(task) {
  return (task.approvals ?? []).filter((approval) =>
    PENDING_APPROVAL_STATUSES.has(approval.status),
  );
}

function lastMeaningfulProgress({ task, processes, latestPlan }) {
  const candidates = [
    task.created_at,
    task.updated_at,
    latestPlan?.updated_at,
    latestPlan?.created_at,
    ...(processes ?? []).flatMap((process) => [
      process.started_at,
      process.ended_at,
    ]),
    ...(task.approvals ?? []).flatMap((approval) => [
      approval.created_at,
      approval.updated_at,
      approval.resolved_at,
    ]),
  ]
    .map(timestampMs)
    .filter((value) => value !== null);
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates)).toISOString();
}

export class TaskActivityService {
  derive({ task, processes = [], activeProcesses, latestPlan, changedFiles = [], completionEvidence = null }) {
    const active = activeProcesses ?? processes.filter((process) =>
      ACTIVE_RUN_STATUSES.has(process.status),
    );
    const approvals = pendingApprovals(task);
    const pendingStarts = task.pending_process_starts ?? [];
    const awaitingUser = approvals.filter(
      (approval) => approval.status === "AWAITING_USER",
    );
    const lastProcess = mostRecentProcess(processes);
    const evidenceBlocker = completionBlocker(task, completionEvidence);
    const lastProgressAt = lastMeaningfulProgress({
      task,
      processes,
      latestPlan,
    });

    let activityState;
    let currentBlocker = null;
    let recommendedNextAction;

    if (task.status !== "ACTIVE") {
      activityState = "TERMINAL";
      recommendedNextAction = "NONE";
    } else if (pendingStarts.length > 0) {
      activityState = "EXECUTING";
      currentBlocker = {
        kind: "RUN",
        code: "RUN_START_PENDING",
        process_ids: pendingStarts.map((reservation) => reservation.process_id),
        owner_instance_ids: [
          ...new Set(
            pendingStarts
              .map((reservation) => reservation.owner_instance_id)
              .filter(Boolean),
          ),
        ],
      };
      recommendedNextAction = "WAIT_FOR_PROCESS";
    } else if (latestPlan?.status === "RUNNING") {
      activityState = "VERIFYING";
      recommendedNextAction = "WAIT_FOR_PLAN";
    } else if (active.length > 0) {
      activityState = "EXECUTING";
      recommendedNextAction = "WAIT_FOR_PROCESS";
    } else if (awaitingUser.length > 0) {
      activityState = "AWAITING_USER";
      currentBlocker = {
        kind: "USER",
        code: "APPROVAL_USER_INPUT_REQUIRED",
        approval_ids: awaitingUser.map((approval) => approval.approval_id),
      };
      recommendedNextAction = "USER_INPUT_REQUIRED";
    } else if (approvals.length > 0) {
      activityState = "AWAITING_APPROVAL";
      currentBlocker = {
        kind: "APPROVAL",
        code: "APPROVAL_REQUIRED",
        approval_ids: approvals.map((approval) => approval.approval_id),
      };
      recommendedNextAction = "APPROVAL_REQUIRED";
    } else if (latestPlan?.status === "AWAITING_USER") {
      activityState = "AWAITING_USER";
      currentBlocker = { kind: "USER", code: latestPlan.blocker?.code ?? "PLAN_HUMAN_CONFIRMATION_REQUIRED", plan_id: latestPlan.plan_id, details: latestPlan.blocker ?? null };
      recommendedNextAction = "USER_INPUT_REQUIRED";
    } else if (latestPlan?.status === "AWAITING_APPROVAL") {
      activityState = "AWAITING_APPROVAL";
      currentBlocker = { kind: "APPROVAL", code: latestPlan.blocker?.code ?? "APPROVAL_REQUIRED", plan_id: latestPlan.plan_id, details: latestPlan.blocker ?? null };
      recommendedNextAction = "APPROVAL_REQUIRED";
    } else if (latestPlan?.status === "AWAITING_ASSISTANT") {
      activityState = "AWAITING_ASSISTANT";
      currentBlocker = {
        kind: "ASSISTANT",
        code: latestPlan.blocker?.code ?? "PLAN_ASSISTANT_REQUIRED",
        plan_id: latestPlan.plan_id,
        details: latestPlan.blocker ?? null,
      };
      recommendedNextAction = "ASSISTANT_REQUIRED";
    } else if (lastProcess?.status === "INTERRUPTED") {
      activityState = "INTERRUPTED";
      currentBlocker = {
        kind: "RUN",
        code: "RUN_INTERRUPTED",
        run_id: lastProcess.process_id,
      };
      recommendedNextAction = "ASSISTANT_REQUIRED";
    } else if (changedFiles.length > 0) {
      activityState = "READY_TO_COMMIT";
      recommendedNextAction = "COMMIT_REQUIRED";
    } else if (evidenceBlocker) {
      activityState = "AWAITING_ASSISTANT";
      currentBlocker = evidenceBlocker;
      recommendedNextAction = "ASSISTANT_REQUIRED";
    } else {
      activityState = "READY_TO_FINISH";
      recommendedNextAction = "TASK_FINISH_REQUIRED";
    }

    return {
      lifecycle_status: task.status,
      activity_state: activityState,
      current_blocker: currentBlocker,
      recommended_next_action: recommendedNextAction,
      last_meaningful_progress_at: lastProgressAt,
      pending_approval_count: approvals.length,
      pending_process_start_count: pendingStarts.length,
    };
  }
}
