import { createHash, randomUUID } from "node:crypto";
import { AgentDockError } from "./errors.js";
import { COMPLETION_EVIDENCE_KINDS } from "./completion-evidence.js";

const PLAN_TERMINAL = new Set([
  "READY_TO_COMMIT",
  "COMPLETED",
  "AWAITING_ASSISTANT",
  "AWAITING_APPROVAL",
  "AWAITING_USER",
  "CANCELLED",
]);
const PLAN_FINAL = new Set(["READY_TO_COMMIT", "COMPLETED", "CANCELLED"]);
const PLAN_OPEN = new Set(["RUNNING", "AWAITING_ASSISTANT", "AWAITING_APPROVAL", "AWAITING_USER"]);
const STEP_TERMINAL = new Set(["PASSED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const MAX_STEPS = 32;
const DEFAULT_POLL_MS = 100;
const MAX_WAIT_MS = 10000;
const MAX_STEP_TIMEOUT_MS = 30 * 60 * 1000;
const DRIVER_LEASE_MS = 3000;
const STEP_ACTIONS = new Set([
  "COMMAND",
  "REASONING_BARRIER",
  "HUMAN_BARRIER",
  "GIT_COMMIT",
  "TASK_FINISH",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function planIdFor(taskId, idempotencyKey) {
  return "plan_" + sha256(taskId + "\0" + idempotencyKey);
}

function planFingerprint(steps) {
  return sha256(JSON.stringify(canonicalize(steps)));
}

function validateDependencies(steps) {
  const ids = new Set(steps.map((step) => step.step_id));
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!ids.has(dependency) || dependency === step.step_id) {
        throw new AgentDockError("INVALID_PLAN_DEPENDENCY", "Plan dependency is missing or self-referential.", { step_id: step.step_id, dependency });
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new AgentDockError("INVALID_PLAN_DEPENDENCY", "Plan dependencies contain a cycle.", { step_id: id });
    if (visited.has(id)) return;
    visiting.add(id);
    const step = steps.find((candidate) => candidate.step_id === id);
    for (const dependency of step.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.step_id);
}

function validateStep(step, index, previousStepId) {
  if (!step || typeof step !== "object") {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "Plan steps must be objects.",
      { index },
    );
  }

  const stepId = String(step.step_id ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(stepId)) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "step_id must use letters, numbers, dot, underscore, or hyphen.",
      { index, step_id: step.step_id ?? null },
    );
  }

  const action = String(step.action ?? "COMMAND").trim().toUpperCase();
  if (!STEP_ACTIONS.has(action)) {
    throw new AgentDockError("INVALID_PLAN_STEP", "Unsupported Plan step action.", { index, step_id: stepId, action });
  }
  const hasArgv = Array.isArray(step.argv);
  const hasShell = typeof step.shell === "string";
  if (action === "COMMAND" && hasArgv === hasShell) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "Each Plan step must provide exactly one of argv or shell.",
      { index, step_id: stepId },
    );
  }
  if (action !== "COMMAND" && (hasArgv || hasShell)) {
    throw new AgentDockError("INVALID_PLAN_STEP", "Only COMMAND steps accept argv or shell.", { index, step_id: stepId });
  }
  if (hasArgv && step.argv.length === 0) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "argv must contain at least one element.",
      { index, step_id: stepId },
    );
  }
  if (hasShell && step.shell.length === 0) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "shell must not be empty.",
      { index, step_id: stepId },
    );
  }

  if (step.env !== undefined) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "Durable Plans do not persist custom env values; use an approved process.start call for secret-bearing environments.",
      { index, step_id: stepId },
    );
  }

  if (
    step.timeout_ms !== undefined &&
    (!Number.isInteger(step.timeout_ms) ||
      step.timeout_ms < 1000 ||
      step.timeout_ms > MAX_STEP_TIMEOUT_MS)
  ) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "timeout_ms must be between 1000 and 1800000.",
      { index, step_id: stepId },
    );
  }

  const dependsOn = step.depends_on === undefined
    ? (previousStepId ? [previousStepId] : [])
    : [...new Set(step.depends_on.map((value) => String(value).trim()).filter(Boolean))];
  const operationKey = String(step.idempotency_key ?? stepId).trim();
  if (!operationKey || operationKey.length > 256) {
    throw new AgentDockError("INVALID_PLAN_STEP", "Step idempotency_key must contain 1 to 256 characters.", { index, step_id: stepId });
  }
  const successExitCodes = step.success_criteria?.exit_codes ?? [0];
  if (!Array.isArray(successExitCodes) || successExitCodes.length === 0 || successExitCodes.some((value) => !Number.isInteger(value))) {
    throw new AgentDockError("INVALID_PLAN_STEP", "success_criteria.exit_codes must contain integers.", { index, step_id: stepId });
  }
  const maxAttempts = step.retry?.max_attempts ?? 1;
  const retrySafe = Boolean(step.retry?.safe);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || (maxAttempts > 1 && !retrySafe)) {
    throw new AgentDockError("INVALID_PLAN_STEP", "Retries require safe=true and max_attempts between 1 and 3.", { index, step_id: stepId });
  }
  if (action === "GIT_COMMIT" && !String(step.message ?? "").trim()) {
    throw new AgentDockError("INVALID_PLAN_STEP", "GIT_COMMIT requires a message.", { index, step_id: stepId });
  }
  if (step.evidence && (!COMPLETION_EVIDENCE_KINDS.includes(String(step.evidence.kind ?? "").trim().toUpperCase()) || !String(step.evidence.summary ?? "").trim())) {
    throw new AgentDockError("INVALID_PLAN_STEP", "Step evidence requires a supported kind and non-empty summary.", { index, step_id: stepId });
  }
  if (action === "TASK_FINISH" && step.outcome === "NO_CHANGE" && !String(step.reason ?? "").trim()) {
    throw new AgentDockError("INVALID_PLAN_STEP", "NO_CHANGE TASK_FINISH requires a reason.", { index, step_id: stepId });
  }
  return {
    step_id: stepId,
    action,
    depends_on: dependsOn,
    idempotency_key: operationKey,
    argv: hasArgv ? [...step.argv] : undefined,
    shell: hasShell ? step.shell : undefined,
    cwd: step.cwd ?? ".",
    timeout_ms: step.timeout_ms ?? null,
    success_criteria: { exit_codes: [...new Set(successExitCodes)] },
    evidence: step.evidence ? {
      kind: String(step.evidence.kind ?? "").trim().toUpperCase(),
      summary: String(step.evidence.summary ?? "").trim(),
    } : null,
    retry: { safe: retrySafe, max_attempts: maxAttempts },
    message: action === "GIT_COMMIT" ? String(step.message).trim() : null,
    outcome: action === "TASK_FINISH" ? (step.outcome ?? null) : null,
    reason: action === "TASK_FINISH" ? (String(step.reason ?? "").trim() || null) : null,
    prompt: ["REASONING_BARRIER", "HUMAN_BARRIER"].includes(action)
      ? (String(step.prompt ?? "").trim() || "Explicit continuation is required.")
      : null,
  };
}

function publicPlan(plan) {
  const current = plan.steps.find((step) => ["RUNNING", "WAITING"].includes(step.status))
    ?? plan.steps.find((step) => step.step_id === plan.blocker?.step_id)
    ?? null;
  const lastSuccessful = [...plan.steps]
    .reverse()
    .find((step) => step.status === "PASSED") ?? null;

  return {
    plan_id: plan.plan_id,
    task_id: plan.task_id,
    status: plan.status,
    revision: plan.revision,
    owner_instance_id: plan.owner_instance_id ?? null,
    driver_id: plan.driver_id ?? null,
    current_step_id: current?.step_id ?? null,
    last_successful_step_id: lastSuccessful?.step_id ?? null,
    blocker: plan.blocker ?? null,
    cancel_requested: Boolean(plan.cancel_requested),
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    completed_at: plan.completed_at ?? null,
    steps: plan.steps.map((step) => ({
      step_id: step.step_id,
      action: step.action ?? "COMMAND",
      depends_on: step.depends_on ?? [],
      idempotency_key: step.idempotency_key ?? step.step_id,
      status: step.status,
      run_id: step.run_id ?? null,
      started_at: step.started_at ?? null,
      ended_at: step.ended_at ?? null,
      exit_code: step.exit_code ?? null,
      signal: step.signal ?? null,
      error: step.error ?? null,
      timeout_ms: step.timeout_ms ?? null,
      attempts: step.attempts ?? 0,
      success_criteria: step.success_criteria ?? { exit_codes: [0] },
      evidence: step.recorded_evidence ?? null,
      result: step.result ?? null,
    })),
  };
}

export class PlanService {
  #store;
  #tasks;
  #processes;
  #audit;
  #git;
  #driverId = "plan_driver_" + randomUUID();
  #drivers = new Map();
  #recoveryTimer;

  constructor({ stateStore, taskService, processService, auditService, gitService }) {
    this.#store = stateStore;
    this.#tasks = taskService;
    this.#processes = processService;
    this.#audit = auditService;
    this.#git = gitService;
    queueMicrotask(() => this.#recoverRunningPlans());
    this.#recoveryTimer = setInterval(() => this.#recoverRunningPlans(), 1000);
    this.#recoveryTimer.unref?.();
  }

  #recoverRunningPlans() {
    try {
      for (const document of this.#store.listDocuments("plan")) {
        if (document.value?.status === "RUNNING") this.#ensureDriver(document.value.plan_id);
      }
    } catch {
      // Runtime shutdown may close the store between interval ticks.
    }
  }

  close() {
    clearInterval(this.#recoveryTimer);
  }

  #load(planId) {
    if (!/^plan_[0-9a-f]{64}$/.test(planId)) {
      throw new AgentDockError("INVALID_PLAN_ID", "Invalid plan_id format.");
    }
    const plan = this.#store.loadDocument("plan", planId);
    if (!plan) {
      throw new AgentDockError("PLAN_NOT_FOUND", "Plan not found: " + planId);
    }
    return plan;
  }

  #mutate(planId, mutator) {
    return this.#store.mutateDocument(
      "plan",
      planId,
      (current) => {
        if (!current) {
          throw new AgentDockError("PLAN_NOT_FOUND", "Plan not found: " + planId);
        }
        const next = mutator(current) ?? current;
        next.revision = (next.revision ?? 0) + 1;
        next.updated_at = new Date().toISOString();
        return next;
      },
      { defaultValue: null },
    );
  }

  latestForTask(taskId) {
    const plans = this.#store
      .listDocuments("plan")
      .map((document) => document.value)
      .filter((plan) => plan?.task_id === taskId)
      .sort((left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)),
      );
    return plans.length > 0 ? publicPlan(plans[0]) : null;
  }

  start({ taskId, idempotencyKey, steps }) {
    this.#tasks.assertActive(taskId);
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new AgentDockError(
        "INVALID_IDEMPOTENCY_KEY",
        "plan.start requires a non-empty idempotency_key.",
      );
    }
    if (idempotencyKey.length > 256) {
      throw new AgentDockError(
        "INVALID_IDEMPOTENCY_KEY",
        "idempotency_key must be at most 256 characters.",
      );
    }
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
      throw new AgentDockError(
        "INVALID_PLAN",
        "Plan must contain between 1 and " + MAX_STEPS + " steps.",
      );
    }

    const normalizedSteps = [];
    for (const [index, step] of steps.entries()) {
      normalizedSteps.push(validateStep(step, index, normalizedSteps.at(-1)?.step_id));
    }
    const ids = normalizedSteps.map((step) => step.step_id);
    if (new Set(ids).size !== ids.length) {
      throw new AgentDockError(
        "INVALID_PLAN",
        "Plan step_id values must be unique.",
      );
    }
    validateDependencies(normalizedSteps);

    const planId = planIdFor(taskId, idempotencyKey);
    const fingerprint = planFingerprint(normalizedSteps);
    const now = new Date().toISOString();
    let created = false;

    const plan = this.#store.mutateDocument(
      "plan",
      planId,
      (current) => {
        if (current) {
          if (
            current.task_id !== taskId ||
            current.request_fingerprint !== fingerprint
          ) {
            throw new AgentDockError(
              "IDEMPOTENCY_KEY_REUSED",
              "The plan idempotency key was already used for different steps.",
              { plan_id: planId },
            );
          }
          return current;
        }

        const active = this.#store
          .listDocuments("plan")
          .map((document) => document.value)
          .find(
            (candidate) =>
              candidate?.task_id === taskId &&
              PLAN_OPEN.has(candidate?.status),
          );
        if (active) {
          throw new AgentDockError(
            "PLAN_ALREADY_ACTIVE",
            "This Task already has an active deterministic Plan.",
            { plan_id: active.plan_id },
          );
        }

        created = true;
        return {
          plan_id: planId,
          task_id: taskId,
          request_fingerprint: fingerprint,
          status: "RUNNING",
          revision: 1,
          owner_instance_id: this.#processes.instanceId,
          driver_id: null,
          driver_lease_until: null,
          cancel_requested: false,
          blocker: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
          steps: normalizedSteps.map((step) => ({
            ...step,
            status: "PENDING",
            run_id: null,
            started_at: null,
            ended_at: null,
            exit_code: null,
            signal: null,
            error: null,
            attempts: 0,
            recorded_evidence: null,
            result: null,
            operation_started_head: null,
          })),
        };
      },
      { defaultValue: null },
    );

    if (created) {
      this.#audit?.append(taskId, {
        event: "PLAN_STARTED",
        plan_id: planId,
        step_count: plan.steps.length,
        owner_instance_id: this.#processes.instanceId,
        started_at: now,
      });
      this.#ensureDriver(planId);
    }
    return {
      ...publicPlan(plan),
      idempotent_replay: !created,
    };
  }

  get({ taskId, planId }) {
    const plan = this.#load(planId);
    if (plan.task_id !== taskId) {
      throw new AgentDockError(
        "PLAN_TASK_MISMATCH",
        "Plan does not belong to this Task.",
      );
    }
    return publicPlan(plan);
  }

  async wait({ taskId, planId, afterRevision, waitMs = 0 }) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new TypeError("waitMs must be an integer between 0 and 10000.");
    }
    if (
      afterRevision !== undefined &&
      (!Number.isInteger(afterRevision) || afterRevision < 0)
    ) {
      throw new TypeError("afterRevision must be a non-negative integer.");
    }

    const deadline = Date.now() + waitMs;
    let current = this.get({ taskId, planId });
    while (
      waitMs > 0 &&
      afterRevision !== undefined &&
      current.revision <= afterRevision &&
      !PLAN_TERMINAL.has(current.status) &&
      Date.now() < deadline
    ) {
      await sleep(Math.min(DEFAULT_POLL_MS, Math.max(1, deadline - Date.now())));
      current = this.get({ taskId, planId });
    }
    return current;
  }

  async cancel({ taskId, planId }) {
    const plan = this.#load(planId);
    if (plan.task_id !== taskId) {
      throw new AgentDockError(
        "PLAN_TASK_MISMATCH",
        "Plan does not belong to this Task.",
      );
    }
    if (PLAN_FINAL.has(plan.status)) return publicPlan(plan);

    const next = this.#mutate(planId, (current) => {
      current.cancel_requested = true;
      if (current.status !== "RUNNING") {
        current.status = "RUNNING";
        current.driver_id = null;
        current.driver_lease_until = null;
      }
      return current;
    });

    const running = next.steps.find((step) => step.status === "RUNNING");
    if (running?.run_id) {
      try {
        const status = await this.#processes.status({
          taskId,
          processId: running.run_id,
        });
        if (status.ownership === "LOCAL") {
          await this.#processes.cancel({
            taskId,
            processId: running.run_id,
          });
        }
      } catch {
        // The durable cancel flag is authoritative. The owning driver will
        // stop after the current Run settles even if this runtime cannot signal it.
      }
    }

    const timer = setTimeout(() => this.#ensureDriver(planId), 10);
    timer.unref?.();
    return publicPlan(next);
  }

  continue({ taskId, planId, stepId, note }) {
    const plan = this.#load(planId);
    if (plan.task_id !== taskId) throw new AgentDockError("PLAN_TASK_MISMATCH", "Plan does not belong to this Task.");
    if (!["AWAITING_ASSISTANT", "AWAITING_APPROVAL", "AWAITING_USER"].includes(plan.status)) {
      throw new AgentDockError("PLAN_NOT_WAITING", "Plan is not at a resumable barrier.", { status: plan.status });
    }
    const barrierCodes = new Set(["PLAN_REASONING_REQUIRED", "PLAN_HUMAN_CONFIRMATION_REQUIRED"]);
    if (plan.status === "AWAITING_ASSISTANT" && !barrierCodes.has(plan.blocker?.code)) {
      throw new AgentDockError("PLAN_REPAIR_REQUIRED", "A failed or ambiguous step requires a new Plan; it cannot be auto-continued.", { blocker: plan.blocker });
    }
    const next = this.#mutate(planId, (current) => {
      const step = current.steps.find((candidate) => candidate.step_id === stepId);
      if (!step || current.blocker?.step_id !== stepId) {
        throw new AgentDockError("PLAN_STEP_MISMATCH", "Continuation must target the current blocked step.");
      }
      if (["REASONING_BARRIER", "HUMAN_BARRIER"].includes(step.action)) {
        step.status = "PASSED";
        step.ended_at = new Date().toISOString();
        step.result = { continued: true, note: String(note ?? "").trim() || null };
      } else {
        step.status = "PENDING";
      }
      current.status = "RUNNING";
      current.blocker = null;
      current.completed_at = null;
      current.driver_id = null;
      current.driver_lease_until = null;
      return current;
    });
    this.#audit?.append(taskId, { event: "PLAN_CONTINUED", plan_id: planId, step_id: stepId, note: String(note ?? "").trim() || null });
    const timer = setTimeout(() => this.#ensureDriver(planId), 10);
    timer.unref?.();
    return publicPlan(next);
  }

  #ensureDriver(planId) {
    if (this.#drivers.has(planId)) return;
    const plan = this.#load(planId);
    if (plan.status !== "RUNNING") {
      return;
    }
    const leaseUntil = Date.parse(plan.driver_lease_until ?? "");
    if (
      plan.driver_id &&
      plan.driver_id !== this.#driverId &&
      Number.isFinite(leaseUntil) &&
      leaseUntil > Date.now()
    ) {
      return;
    }
    let claimed = false;
    this.#mutate(planId, (current) => {
      const currentLease = Date.parse(current.driver_lease_until ?? "");
      if (
        current.status === "RUNNING" &&
        (!current.driver_id || current.driver_id === this.#driverId || !Number.isFinite(currentLease) || currentLease <= Date.now())
      ) {
        current.driver_id = this.#driverId;
        current.driver_lease_until = new Date(Date.now() + DRIVER_LEASE_MS).toISOString();
        claimed = true;
      }
      return current;
    });
    if (!claimed) {
      return;
    }
    const promise = this.#drive(planId)
      .catch((error) => {
        try {
          const plan = this.#load(planId);
          if (!PLAN_TERMINAL.has(plan.status)) {
            this.#mutate(planId, (current) => {
              current.status = "AWAITING_ASSISTANT";
              current.blocker = {
                code: "PLAN_DRIVER_ERROR",
                message: error?.message ?? String(error),
              };
              current.completed_at = new Date().toISOString();
              return current;
            });
          }
        } catch {
          // Preserve the original failure; a later status read can diagnose it.
        }
      })
      .finally(() => this.#drivers.delete(planId));
    this.#drivers.set(planId, promise);
  }

  #renewDriver(planId) {
    const snapshot = this.#load(planId);
    if (snapshot.driver_id !== this.#driverId || snapshot.status !== "RUNNING") return false;
    if (Date.parse(snapshot.driver_lease_until ?? "") - Date.now() > DRIVER_LEASE_MS / 2) return true;
    let owned = false;
    this.#mutate(planId, (current) => {
      if (current.status === "RUNNING" && current.driver_id === this.#driverId) {
        current.driver_lease_until = new Date(Date.now() + DRIVER_LEASE_MS).toISOString();
        owned = true;
      }
      return current;
    });
    return owned;
  }

  async #executeTaskAction(plan, step, stepIndex) {
    const task = this.#tasks.get(plan.task_id);
    try {
      let result;
      if (step.action === "GIT_COMMIT") {
        const beforeHead = await this.#git.currentHead(task.worktree_path);
        if (step.status === "PENDING") {
          plan = this.#mutate(plan.plan_id, (current) => {
            const currentStep = current.steps[stepIndex];
            currentStep.status = "RUNNING";
            currentStep.started_at ??= new Date().toISOString();
            currentStep.attempts = (currentStep.attempts ?? 0) + 1;
            currentStep.operation_started_head = beforeHead;
            return current;
          });
          step = plan.steps[stepIndex];
        }
        const diff = await this.#git.diff(task.worktree_path);
        if (diff.changed_files.length === 0 && beforeHead !== step.operation_started_head) {
          result = { commit_sha: beforeHead, recovered: true, worktree_clean: true };
        } else {
          result = await this.#git.commit(task.worktree_path, { message: step.message });
        }
        this.#tasks.recordCommit(plan.task_id, result.commit_sha);
      } else if (step.action === "TASK_FINISH") {
        if (task.status === "COMPLETED") {
          result = { outcome: task.outcome, final_commit_sha: task.final_commit_sha, recovered: true };
        } else {
          const active = await this.#processes.activeForTask(plan.task_id);
          if (active.length > 0) throw new AgentDockError("TASK_PROCESSES_ACTIVE", "Task still has active processes.", { processes: active });
          const diff = await this.#git.diff(task.worktree_path);
          if (diff.changed_files.length > 0) throw new AgentDockError("TASK_UNCOMMITTED_CHANGES", "Task worktree must be clean before finish.", { changed_files: diff.changed_files });
          const finalCommitSha = await this.#git.currentHead(task.worktree_path);
          const hasNewCommit = finalCommitSha !== task.base_head;
          const outcome = step.outcome ?? (hasNewCommit ? "COMMIT" : null);
          if (!outcome) throw new AgentDockError("TASK_OUTCOME_REQUIRED", "A Task with no new commit requires explicit NO_CHANGE.");
          if (outcome === "COMMIT" && !hasNewCommit) throw new AgentDockError("TASK_COMMIT_REQUIRED", "COMMIT requires a new Task commit.");
          if (outcome === "NO_CHANGE" && hasNewCommit) throw new AgentDockError("TASK_NO_CHANGE_HAS_COMMIT", "NO_CHANGE cannot hide a new Task commit.");
          const retentionRef = outcome === "COMMIT"
            ? await this.#git.retainTaskCommit({ repoRoot: task.source_repo, taskId: task.task_id, commitSha: finalCommitSha })
            : null;
          const finished = this.#tasks.finish(plan.task_id, {
            finalCommitSha,
            outcome,
            outcomeReason: outcome === "NO_CHANGE" ? step.reason : null,
            retentionRef,
          });
          result = { outcome: finished.outcome, final_commit_sha: finished.final_commit_sha, retention_ref: finished.retention_ref, verification_status: finished.verification_status };
        }
      }

      const updated = this.#mutate(plan.plan_id, (current) => {
        const currentStep = current.steps[stepIndex];
        currentStep.status = "PASSED";
        currentStep.started_at ??= new Date().toISOString();
        currentStep.ended_at = new Date().toISOString();
        currentStep.result = result;
        currentStep.error = null;
        return current;
      });
      this.#audit?.append(updated.task_id, { event: "PLAN_STEP_PASSED", plan_id: plan.plan_id, step_id: step.step_id, action: step.action, result });
      return true;
    } catch (error) {
      const failed = this.#mutate(plan.plan_id, (current) => {
        const currentStep = current.steps[stepIndex];
        currentStep.status = "FAILED";
        currentStep.started_at ??= new Date().toISOString();
        currentStep.ended_at = new Date().toISOString();
        currentStep.error = error?.message ?? String(error);
        current.status = "AWAITING_ASSISTANT";
        current.completed_at = new Date().toISOString();
        current.blocker = { code: "PLAN_ACTION_FAILED", step_id: step.step_id, action: step.action, error_code: error?.code ?? null, message: error?.message ?? String(error) };
        return current;
      });
      this.#audit?.append(failed.task_id, { event: "PLAN_STEP_FAILED", plan_id: plan.plan_id, step_id: step.step_id, blocker: failed.blocker });
      return false;
    }
  }

  async #drive(planId) {
    while (true) {
      let plan = this.#load(planId);
      if (PLAN_TERMINAL.has(plan.status)) return;
      if (!this.#renewDriver(planId)) return;
      plan = this.#load(planId);

      if (plan.cancel_requested) {
        const cancelled = this.#mutate(planId, (current) => {
          current.status = "CANCELLED";
          current.completed_at = new Date().toISOString();
          current.blocker = {
            code: "PLAN_CANCELLED",
            message: "Plan cancellation was requested.",
          };
          const running = current.steps.find((step) => ["RUNNING", "WAITING"].includes(step.status));
          if (running && !STEP_TERMINAL.has(running.status)) {
            running.status = "CANCELLED";
            running.ended_at = new Date().toISOString();
          }
          return current;
        });
        this.#audit?.append(cancelled.task_id, {
          event: "PLAN_CANCELLED",
          plan_id: planId,
          cancelled_at: cancelled.completed_at,
        });
        return;
      }

      let stepIndex = plan.steps.findIndex((step) => step.status === "RUNNING");
      if (stepIndex === -1) {
        stepIndex = plan.steps.findIndex(
          (step) => step.status === "PENDING" && step.depends_on.every(
            (dependency) => plan.steps.find((candidate) => candidate.step_id === dependency)?.status === "PASSED",
          ),
        );
      }
      if (stepIndex === -1) {
        const pending = plan.steps.filter((step) => step.status === "PENDING");
        if (pending.length > 0) {
          const blocked = this.#mutate(planId, (current) => {
            current.status = "AWAITING_ASSISTANT";
            current.blocker = { code: "PLAN_DEPENDENCY_BLOCKED", step_ids: pending.map((step) => step.step_id) };
            current.completed_at = new Date().toISOString();
            return current;
          });
          this.#audit?.append(blocked.task_id, { event: "PLAN_BLOCKED", plan_id: planId, blocker: blocked.blocker });
          return;
        }
        const completed = this.#mutate(planId, (current) => {
          current.status = this.#tasks.get(current.task_id).status === "COMPLETED" ? "COMPLETED" : "READY_TO_COMMIT";
          current.completed_at = new Date().toISOString();
          current.blocker = null;
          return current;
        });
        this.#audit?.append(completed.task_id, {
          event: "PLAN_COMPLETED",
          plan_id: planId,
          status: completed.status,
          completed_at: completed.completed_at,
        });
        return;
      }

      let step = plan.steps[stepIndex];
      if (step.action !== "COMMAND" && !["REASONING_BARRIER", "HUMAN_BARRIER"].includes(step.action)) {
        const completed = await this.#executeTaskAction(plan, step, stepIndex);
        if (completed) continue;
        return;
      }
      if (step.status === "PENDING") {
        if (["REASONING_BARRIER", "HUMAN_BARRIER"].includes(step.action)) {
          const waiting = this.#mutate(planId, (current) => {
            const currentStep = current.steps[stepIndex];
            currentStep.status = "WAITING";
            currentStep.started_at ??= new Date().toISOString();
            current.status = currentStep.action === "HUMAN_BARRIER" ? "AWAITING_USER" : "AWAITING_ASSISTANT";
            current.blocker = {
              code: currentStep.action === "HUMAN_BARRIER" ? "PLAN_HUMAN_CONFIRMATION_REQUIRED" : "PLAN_REASONING_REQUIRED",
              step_id: currentStep.step_id,
              prompt: currentStep.prompt,
            };
            current.completed_at = new Date().toISOString();
            return current;
          });
          this.#audit?.append(waiting.task_id, { event: "PLAN_BARRIER_REACHED", plan_id: planId, blocker: waiting.blocker });
          return;
        }

        let started;
        try {
          started = await this.#processes.start({
            taskId: plan.task_id,
            argv: step.argv,
            shell: step.shell,
            cwd: step.cwd,
            idempotencyKey: planId + ":" + step.idempotency_key + ":" + ((step.attempts ?? 0) + 1),
          });
        } catch (error) {
          if (error?.code === "APPROVAL_REQUIRED") {
            const waiting = this.#mutate(planId, (current) => {
              current.status = error.details?.approval_request?.status === "AWAITING_USER" ? "AWAITING_USER" : "AWAITING_APPROVAL";
              current.blocker = { code: error.code, step_id: step.step_id, ...(error.details ?? {}) };
              current.completed_at = new Date().toISOString();
              return current;
            });
            this.#audit?.append(waiting.task_id, { event: "PLAN_APPROVAL_REQUIRED", plan_id: planId, blocker: waiting.blocker });
            return;
          }
          throw error;
        }

        plan = this.#mutate(planId, (current) => {
          const currentStep = current.steps[stepIndex];
          current.owner_instance_id = this.#processes.instanceId;
          currentStep.status = "RUNNING";
          currentStep.run_id = started.process_id;
          currentStep.started_at ??= new Date().toISOString();
          currentStep.attempts = (currentStep.attempts ?? 0) + 1;
          return current;
        });
        step = plan.steps[stepIndex];
      }

      const startedAtMs = Date.parse(step.started_at);
      const timeoutMs = step.timeout_ms;
      let terminal = null;

      while (!terminal) {
        plan = this.#load(planId);
        if (plan.cancel_requested) break;
        if (!this.#renewDriver(planId)) return;

        const status = await this.#processes.status({
          taskId: plan.task_id,
          processId: step.run_id,
        });

        if (!["RUNNING", "CANCELLING"].includes(status.status)) {
          terminal = status;
          break;
        }

        if (
          timeoutMs &&
          Number.isFinite(startedAtMs) &&
          Date.now() - startedAtMs >= timeoutMs
        ) {
          if (status.ownership === "LOCAL") {
            try {
              await this.#processes.cancel({
                taskId: plan.task_id,
                processId: step.run_id,
              });
            } catch {
              // Record the timeout below even if cancellation races the child exit.
            }
          }
          terminal = {
            ...status,
            status: "FAILED",
            error: "Plan step exceeded timeout_ms.",
          };
          break;
        }

        await sleep(DEFAULT_POLL_MS);
      }

      if (plan.cancel_requested) continue;

      const success = terminal.status === "EXITED" && step.success_criteria.exit_codes.includes(terminal.exit_code);
      if (success) {
        const updated = this.#mutate(planId, (current) => {
          const currentStep = current.steps[stepIndex];
          currentStep.status = "PASSED";
          currentStep.ended_at = terminal.ended_at ?? new Date().toISOString();
          currentStep.exit_code = terminal.exit_code;
          currentStep.signal = terminal.signal ?? null;
          currentStep.error = null;
          return current;
        });
        let evidence = null;
        if (step.evidence) {
          const task = this.#tasks.get(updated.task_id);
          const subjectSha = await this.#git.currentHead(task.worktree_path);
          const recorded = this.#tasks.recordEvidence(updated.task_id, {
            kind: step.evidence.kind,
            status: "PASS",
            summary: step.evidence.summary,
            subjectSha,
            runId: step.run_id,
            details: { plan_id: planId, step_id: step.step_id, exit_code: terminal.exit_code },
          });
          evidence = recorded.result;
          this.#mutate(planId, (current) => {
            current.steps[stepIndex].recorded_evidence = evidence;
            return current;
          });
        }
        this.#audit?.append(updated.task_id, {
          event: "PLAN_STEP_PASSED",
          plan_id: planId,
          step_id: step.step_id,
          run_id: step.run_id,
          exit_code: terminal.exit_code,
          ended_at: terminal.ended_at,
        });
        continue;
      }

      if ((step.attempts ?? 0) < (step.retry?.max_attempts ?? 1)) {
        const retrying = this.#mutate(planId, (current) => {
          const currentStep = current.steps[stepIndex];
          currentStep.status = "PENDING";
          currentStep.run_id = null;
          currentStep.started_at = null;
          currentStep.ended_at = terminal.ended_at ?? new Date().toISOString();
          currentStep.exit_code = terminal.exit_code ?? null;
          currentStep.error = terminal.error ?? null;
          return current;
        });
        this.#audit?.append(retrying.task_id, { event: "PLAN_STEP_RETRYING", plan_id: planId, step_id: step.step_id, attempt: step.attempts });
        continue;
      }

      let failedEvidence = null;
      if (step.evidence) {
        const task = this.#tasks.get(plan.task_id);
        const subjectSha = await this.#git.currentHead(task.worktree_path);
        failedEvidence = this.#tasks.recordEvidence(plan.task_id, {
          kind: step.evidence.kind,
          status: "FAIL",
          summary: step.evidence.summary,
          subjectSha,
          runId: step.run_id,
          details: { plan_id: planId, step_id: step.step_id, exit_code: terminal.exit_code ?? null },
        }).result;
      }

      const failed = this.#mutate(planId, (current) => {
        const currentStep = current.steps[stepIndex];
        currentStep.status =
          terminal.status === "CANCELLED"
            ? "CANCELLED"
            : terminal.status === "INTERRUPTED"
              ? "INTERRUPTED"
              : "FAILED";
        currentStep.ended_at = terminal.ended_at ?? new Date().toISOString();
        currentStep.exit_code = terminal.exit_code ?? null;
        currentStep.signal = terminal.signal ?? null;
        currentStep.error = terminal.error ?? null;
        currentStep.recorded_evidence = failedEvidence;
        current.status = "AWAITING_ASSISTANT";
        current.completed_at = new Date().toISOString();
        current.blocker = {
          code: "PLAN_STEP_FAILED",
          step_id: step.step_id,
          run_id: step.run_id,
          run_status: terminal.status,
          exit_code: terminal.exit_code ?? null,
          signal: terminal.signal ?? null,
          error: terminal.error ?? null,
        };
        return current;
      });
      this.#audit?.append(failed.task_id, {
        event: "PLAN_STEP_FAILED",
        plan_id: planId,
        step_id: step.step_id,
        run_id: step.run_id,
        blocker: failed.blocker,
        ended_at: failed.completed_at,
      });
      return;
    }
  }
}
