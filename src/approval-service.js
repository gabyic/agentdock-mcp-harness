import { createHash, randomUUID } from "node:crypto";
import { AgentDockError } from "./errors.js";

const DECISIONS = new Set([
  "ALLOW_ONCE",
  "ALLOW_TASK",
  "DENY",
  "ASK_USER",
]);

function fingerprintOperation(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export class ApprovalService {
  #tasks;
  #policy;

  constructor({ taskService, policyService }) {
    this.#tasks = taskService;
    this.#policy = policyService;
  }

  #ensureState(task) {
    task.approvals ??= [];
    task.approval_grants ??= [];
  }

  #persist(task) {
    task.updated_at = new Date().toISOString();
    this.#tasks.save(task);
  }

  authorize({ taskId, tool, shell, argv, cwd, env = {} }) {
    const task = this.#tasks.get(taskId);
    this.#ensureState(task);

    const policy = this.#policy.evaluate({ tool, shell, argv });
    if (policy.effect === "allow") {
      return { allowed: true, policy };
    }

    if (policy.effect === "deny") {
      throw new AgentDockError(
        "POLICY_DENIED",
        "Operation denied by deterministic policy.",
        {
          rule_id: policy.rule_id,
          tool,
        },
      );
    }

    const fingerprintPayload = {
      tool,
      shell: shell ?? null,
      argv: argv ?? null,
      cwd: cwd ?? ".",
      env,
    };
    const operation = {
      tool,
      shell: shell ?? null,
      argv: argv ?? null,
      cwd: cwd ?? ".",
      env_keys: Object.keys(env).sort(),
    };
    const fingerprint = fingerprintOperation(fingerprintPayload);

    const taskGrant = task.approval_grants.find(
      (grant) =>
        grant.kind === "ALLOW_TASK" &&
        grant.approval_scope === policy.approval_scope,
    );
    if (taskGrant) {
      return {
        allowed: true,
        policy,
        grant: taskGrant,
      };
    }

    const onceIndex = task.approval_grants.findIndex(
      (grant) =>
        grant.kind === "ALLOW_ONCE" &&
        grant.fingerprint === fingerprint &&
        grant.approval_scope === policy.approval_scope,
    );
    if (onceIndex !== -1) {
      const [grant] = task.approval_grants.splice(onceIndex, 1);
      this.#persist(task);
      return {
        allowed: true,
        policy,
        grant,
      };
    }

    const existing = task.approvals.find(
      (approval) =>
        approval.fingerprint === fingerprint &&
        approval.rule_id === policy.rule_id &&
        (approval.status === "PENDING" ||
          approval.status === "AWAITING_USER"),
    );

    if (existing) {
      throw new AgentDockError(
        "APPROVAL_REQUIRED",
        "Operation requires approval before execution.",
        { approval_request: existing },
      );
    }

    const now = new Date().toISOString();
    const request = {
      approval_id: "apr_" + randomUUID(),
      task_id: taskId,
      status: "PENDING",
      rule_id: policy.rule_id,
      approval_scope: policy.approval_scope,
      tool,
      operation,
      fingerprint,
      created_at: now,
      updated_at: now,
      decision: null,
      resolved_at: null,
    };

    task.approvals.push(request);
    this.#persist(task);

    throw new AgentDockError(
      "APPROVAL_REQUIRED",
      "Operation requires approval before execution.",
      { approval_request: request },
    );
  }

  get({ taskId, approvalId }) {
    const task = this.#tasks.get(taskId);
    this.#ensureState(task);
    const approval = task.approvals.find(
      (item) => item.approval_id === approvalId,
    );
    if (!approval) {
      throw new AgentDockError(
        "APPROVAL_NOT_FOUND",
        "Approval request not found: " + approvalId,
      );
    }
    return approval;
  }

  respond({ taskId, approvalId, decision }) {
    this.#tasks.assertActive(taskId);

    if (!DECISIONS.has(decision)) {
      throw new AgentDockError(
        "INVALID_APPROVAL_DECISION",
        "Unsupported approval decision: " + decision,
      );
    }

    const task = this.#tasks.get(taskId);
    this.#ensureState(task);
    const approval = task.approvals.find(
      (item) => item.approval_id === approvalId,
    );
    if (!approval) {
      throw new AgentDockError(
        "APPROVAL_NOT_FOUND",
        "Approval request not found: " + approvalId,
      );
    }

    if (
      approval.status !== "PENDING" &&
      approval.status !== "AWAITING_USER"
    ) {
      throw new AgentDockError(
        "APPROVAL_ALREADY_RESOLVED",
        "Approval request has already been resolved.",
      );
    }

    const now = new Date().toISOString();
    approval.decision = decision;
    approval.updated_at = now;

    if (decision === "ASK_USER") {
      approval.status = "AWAITING_USER";
      approval.resolved_at = null;
      this.#persist(task);
      return {
        approval,
        grant: null,
      };
    }

    if (decision === "DENY") {
      approval.status = "DENIED";
      approval.resolved_at = now;
      this.#persist(task);
      return {
        approval,
        grant: null,
      };
    }

    approval.status = "APPROVED";
    approval.resolved_at = now;

    const grant = {
      grant_id: "grant_" + randomUUID(),
      task_id: taskId,
      approval_id: approvalId,
      kind: decision,
      approval_scope: approval.approval_scope,
      fingerprint: approval.fingerprint,
      created_at: now,
    };
    task.approval_grants.push(grant);
    this.#persist(task);

    return {
      approval,
      grant,
    };
  }
}
