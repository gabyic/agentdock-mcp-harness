import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const ACTIVE_RUN_STATUSES = new Set(["RUNNING", "CANCELLING"]);

async function pathSize(target) {
  let rootStat;
  try {
    rootStat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, bytes: 0 };
    }
    throw error;
  }

  if (!rootStat.isDirectory()) {
    return { exists: true, bytes: rootStat.size };
  }

  let bytes = rootStat.size;
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const stat = await lstat(entryPath);
      bytes += stat.size;
      continue;
    }
    const child = await pathSize(entryPath);
    bytes += child.bytes;
  }
  return { exists: true, bytes };
}

function pendingApprovals(task) {
  return (task.approvals ?? []).filter((approval) =>
    ["PENDING", "AWAITING_USER"].includes(approval.status),
  );
}

function timestampMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function latestProcessActivityByTask(metadata) {
  const map = new Map();
  for (const process of metadata) {
    if (!process.task_id) continue;
    const stamp =
      timestampMs(process.ended_at) ??
      timestampMs(process.started_at);
    if (stamp === null) continue;
    const existing = map.get(process.task_id);
    if (!existing || stamp > existing.timestamp_ms) {
      map.set(process.task_id, {
        timestamp_ms: stamp,
        at: new Date(stamp).toISOString(),
      });
    }
  }
  return map;
}

function latestPlansByTask(documents) {
  const map = new Map();
  for (const document of documents) {
    const plan = document.value;
    if (!plan?.task_id) continue;
    const existing = map.get(plan.task_id);
    if (
      !existing ||
      String(plan.created_at ?? "") > String(existing.created_at ?? "")
    ) {
      map.set(plan.task_id, plan);
    }
  }
  return map;
}

function activeRunsByTask(metadata) {
  const map = new Map();
  for (const process of metadata) {
    if (!process.task_id || !ACTIVE_RUN_STATUSES.has(process.status)) continue;
    const current = map.get(process.task_id) ?? [];
    current.push(process);
    map.set(process.task_id, current);
  }
  return map;
}

function publicPlanStatus(plan) {
  if (!plan) return null;
  const currentStep =
    (plan.steps ?? []).find((step) => step.status === "RUNNING") ?? null;
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    current_step_id: currentStep?.step_id ?? null,
    blocker: plan.blocker ?? null,
    updated_at: plan.updated_at ?? plan.created_at ?? null,
  };
}

function blockersFor({ task, activeProcesses, latestPlan }) {
  const blockers = [];
  const approvals = pendingApprovals(task);

  if (approvals.length > 0) {
    blockers.push({
      kind: "APPROVAL",
      count: approvals.length,
      approval_ids: approvals.map((approval) => approval.approval_id),
    });
  }

  if (latestPlan?.status === "RUNNING") {
    blockers.push({
      kind: "PLAN_RUNNING",
      plan_id: latestPlan.plan_id,
      current_step_id: latestPlan.current_step_id,
    });
  } else if (latestPlan?.status === "AWAITING_ASSISTANT") {
    blockers.push({
      kind: "ASSISTANT",
      plan_id: latestPlan.plan_id,
      blocker: latestPlan.blocker ?? null,
    });
  }

  if (activeProcesses.length > 0) {
    blockers.push({
      kind: "RUN",
      count: activeProcesses.length,
      run_ids: activeProcesses.map((process) => process.process_id),
    });
  }

  return blockers;
}

export class TaskHygieneService {
  #tasks;
  #stateStore;
  #git;
  #activity;

  constructor({ taskService, stateStore, gitService, taskActivityService }) {
    this.#tasks = taskService;
    this.#stateStore = stateStore;
    this.#git = gitService;
    this.#activity = taskActivityService;
  }

  async list({
    staleAfterSeconds = 3600,
    includeFinalized = true,
  } = {}) {
    if (
      !Number.isInteger(staleAfterSeconds) ||
      staleAfterSeconds < 60 ||
      staleAfterSeconds > 365 * 24 * 60 * 60
    ) {
      throw new TypeError(
        "staleAfterSeconds must be an integer between 60 and 31536000.",
      );
    }

    const now = Date.now();
    const allTasks = this.#tasks.list();
    const tasks = allTasks.filter(
      (task) => includeFinalized || task.status === "ACTIVE",
    );
    const processMetadata = this.#stateStore.listProcessMetadata();
    const activeRuns = activeRunsByTask(processMetadata);
    const processActivity = latestProcessActivityByTask(processMetadata);
    const latestPlans = latestPlansByTask(
      this.#stateStore.listDocuments("plan"),
    );

    const stateDir = this.#stateStore.stateDir;
    const worktreesRoot = path.join(stateDir, "worktrees");
    let worktreeEntries = [];
    try {
      worktreeEntries = await readdir(worktreesRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const worktreeSizes = new Map();
    let worktreesBytes = 0;
    for (const entry of worktreeEntries) {
      const target = path.join(worktreesRoot, entry.name);
      const usage = await pathSize(target);
      worktreeSizes.set(entry.name, usage);
      worktreesBytes += usage.bytes;
    }

    let nonWorktreeStateBytes = 0;
    let stateEntries = [];
    try {
      stateEntries = await readdir(stateDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of stateEntries) {
      if (entry.name === "worktrees") continue;
      const usage = await pathSize(path.join(stateDir, entry.name));
      nonWorktreeStateBytes += usage.bytes;
    }

    const taskIds = new Set(allTasks.map((task) => task.task_id));
    let orphanWorktreeCount = 0;
    let orphanWorktreeBytes = 0;
    for (const [name, usage] of worktreeSizes) {
      if (!taskIds.has(name)) {
        orphanWorktreeCount += 1;
        orphanWorktreeBytes += usage.bytes;
      }
    }

    const output = [];
    for (const task of tasks) {
      const activeProcesses =
        task.status === "ACTIVE" ? activeRuns.get(task.task_id) ?? [] : [];
      const latestPlan = publicPlanStatus(latestPlans.get(task.task_id));
      const taskActivityMs =
        timestampMs(task.updated_at) ?? timestampMs(task.created_at);
      const processActivityMs =
        processActivity.get(task.task_id)?.timestamp_ms ?? null;
      const planActivityMs = timestampMs(latestPlan?.updated_at);
      const activityCandidates = [
        taskActivityMs,
        processActivityMs,
        planActivityMs,
      ].filter((value) => value !== null);
      const lastActivityMs =
        activityCandidates.length > 0 ? Math.max(...activityCandidates) : null;
      const lastActivityAt =
        lastActivityMs === null ? null : new Date(lastActivityMs).toISOString();
      const age =
        lastActivityMs === null
          ? null
          : Math.max(0, Math.floor((now - lastActivityMs) / 1000));
      const blockers = blockersFor({
        task,
        activeProcesses,
        latestPlan,
      });
      const worktreeUsage =
        worktreeSizes.get(path.basename(task.worktree_path)) ??
        (await pathSize(task.worktree_path));
      const changedFiles =
        task.status === "ACTIVE" && worktreeUsage.exists
          ? (await this.#git.diff(task.worktree_path)).changed_files
          : [];
      const taskProcesses = processMetadata.filter(
        (process) => process.task_id === task.task_id,
      );
      const activity = this.#activity.derive({
        task,
        processes: taskProcesses,
        activeProcesses,
        latestPlan,
        changedFiles,
      });
      const stale =
        task.status === "ACTIVE" &&
        activeProcesses.length === 0 &&
        latestPlan?.status !== "RUNNING" &&
        age !== null &&
        age >= staleAfterSeconds;

      output.push({
        task_id: task.task_id,
        status: task.status,
        source_repo: task.source_repo,
        outcome: task.outcome ?? null,
        final_commit_sha: task.final_commit_sha ?? null,
        retention_ref: task.retention_ref ?? null,
        workspace_cleaned: Boolean(task.workspace_cleaned),
        worktree_path: task.worktree_path,
        worktree_present: worktreeUsage.exists,
        worktree_bytes: worktreeUsage.bytes,
        active_run_count: activeProcesses.length,
        active_run_ids: activeProcesses.map((process) => process.process_id),
        latest_plan_status: latestPlan?.status ?? null,
        pending_approval_count: pendingApprovals(task).length,
        blockers,
        ...activity,
        last_activity_at: lastActivityAt,
        last_activity_age_seconds: age,
        age_seconds: age,
        stale,
        needs_attention: stale,
        created_at: task.created_at,
        updated_at: task.updated_at,
      });
    }

    const stateDirBytes = nonWorktreeStateBytes + worktreesBytes;
    return {
      task_count: output.length,
      active_task_count: output.filter((task) => task.status === "ACTIVE").length,
      stale_task_count: output.filter((task) => task.stale).length,
      uncleaned_task_count: output.filter((task) => !task.workspace_cleaned).length,
      stale_after_seconds: staleAfterSeconds,
      storage: {
        state_dir: stateDir,
        state_backend: this.#stateStore.backend,
        state_dir_bytes: stateDirBytes,
        worktrees_dir_bytes: worktreesBytes,
        non_worktree_state_bytes: nonWorktreeStateBytes,
        orphan_worktree_count: orphanWorktreeCount,
        orphan_worktree_bytes: orphanWorktreeBytes,
      },
      tasks: output,
    };
  }
}
