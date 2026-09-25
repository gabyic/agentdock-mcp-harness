import { createHash, randomUUID } from "node:crypto";
import { AgentDockError } from "./errors.js";

const PLAN_TERMINAL = new Set([
  "READY_TO_COMMIT",
  "AWAITING_ASSISTANT",
  "CANCELLED",
]);
const STEP_TERMINAL = new Set(["PASSED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const MAX_STEPS = 32;
const DEFAULT_POLL_MS = 100;
const MAX_WAIT_MS = 10000;
const MAX_STEP_TIMEOUT_MS = 30 * 60 * 1000;

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

function validateStep(step, index) {
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

  const hasArgv = Array.isArray(step.argv);
  const hasShell = typeof step.shell === "string";
  if (hasArgv === hasShell) {
    throw new AgentDockError(
      "INVALID_PLAN_STEP",
      "Each Plan step must provide exactly one of argv or shell.",
      { index, step_id: stepId },
    );
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
      "Minimal durable Plans do not accept custom env yet; use the runtime environment until durable secret redaction is implemented.",
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

  return {
    step_id: stepId,
    argv: hasArgv ? [...step.argv] : undefined,
    shell: hasShell ? step.shell : undefined,
    cwd: step.cwd ?? ".",
    timeout_ms: step.timeout_ms ?? null,
  };
}

function publicPlan(plan) {
  const current = plan.steps.find((step) => step.status === "RUNNING") ?? null;
  const lastSuccessful = [...plan.steps]
    .reverse()
    .find((step) => step.status === "PASSED") ?? null;

  return {
    plan_id: plan.plan_id,
    task_id: plan.task_id,
    status: plan.status,
    revision: plan.revision,
    owner_instance_id: plan.owner_instance_id ?? null,
    current_step_id: current?.step_id ?? null,
    last_successful_step_id: lastSuccessful?.step_id ?? null,
    blocker: plan.blocker ?? null,
    cancel_requested: Boolean(plan.cancel_requested),
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    completed_at: plan.completed_at ?? null,
    steps: plan.steps.map((step) => ({
      step_id: step.step_id,
      status: step.status,
      run_id: step.run_id ?? null,
      started_at: step.started_at ?? null,
      ended_at: step.ended_at ?? null,
      exit_code: step.exit_code ?? null,
      signal: step.signal ?? null,
      error: step.error ?? null,
      timeout_ms: step.timeout_ms ?? null,
    })),
  };
}

export class PlanService {
  #store;
  #tasks;
  #processes;
  #audit;
  #drivers = new Map();

  constructor({ stateStore, taskService, processService, auditService }) {
    this.#store = stateStore;
    this.#tasks = taskService;
    this.#processes = processService;
    this.#audit = auditService;
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

    const normalizedSteps = steps.map(validateStep);
    const ids = normalizedSteps.map((step) => step.step_id);
    if (new Set(ids).size !== ids.length) {
      throw new AgentDockError(
        "INVALID_PLAN",
        "Plan step_id values must be unique.",
      );
    }

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
              candidate?.status === "RUNNING",
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
    if (PLAN_TERMINAL.has(plan.status)) return publicPlan(plan);

    const next = this.#mutate(planId, (current) => {
      current.cancel_requested = true;
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

    this.#ensureDriver(planId);
    return publicPlan(next);
  }

  #ensureDriver(planId) {
    if (this.#drivers.has(planId)) return;
    const plan = this.#load(planId);
    if (plan.status !== "RUNNING") {
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

  async #drive(planId) {
    while (true) {
      let plan = this.#load(planId);
      if (PLAN_TERMINAL.has(plan.status)) return;

      if (plan.cancel_requested) {
        const cancelled = this.#mutate(planId, (current) => {
          current.status = "CANCELLED";
          current.completed_at = new Date().toISOString();
          current.blocker = {
            code: "PLAN_CANCELLED",
            message: "Plan cancellation was requested.",
          };
          const running = current.steps.find((step) => step.status === "RUNNING");
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

      const stepIndex = plan.steps.findIndex(
        (step) => step.status === "PENDING" || step.status === "RUNNING",
      );
      if (stepIndex === -1) {
        const completed = this.#mutate(planId, (current) => {
          current.status = "READY_TO_COMMIT";
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
      if (step.status === "PENDING") {
        const started = await this.#processes.start({
          taskId: plan.task_id,
          argv: step.argv,
          shell: step.shell,
          cwd: step.cwd,
          idempotencyKey: planId + ":" + step.step_id,
        });

        plan = this.#mutate(planId, (current) => {
          const currentStep = current.steps[stepIndex];
          current.owner_instance_id = this.#processes.instanceId;
          currentStep.status = "RUNNING";
          currentStep.run_id = started.process_id;
          currentStep.started_at ??= new Date().toISOString();
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

      const success =
        terminal.status === "EXITED" && terminal.exit_code === 0;
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
