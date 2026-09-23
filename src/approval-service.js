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

function ensureApprovalState(task) {
  task.approvals ??= [];
  task.approval_grants ??= [];
}

function assertTaskActive(task) {
  if (task.status !== "ACTIVE" || task.workspace_cleaned) {
    throw new AgentDockError(
      "TASK_NOT_ACTIVE",
      "Approval changes require an ACTIVE Task.",
      { status: task.status },
    );
  }
}

export class ApprovalService {
  #tasks;
  #policy;
  #audit;

  constructor({ taskService, policyService, auditService }) {
    this.#tasks = taskService;
    this.#policy = policyService;
    this.#audit = auditService;
  }

  authorize({
    taskId,
    tool,
    shell,
    argv,
    cwd,
    env = {},
    humanConfirmed = false,
    requirePolicyApproval = false,
  }) {
    const policy = this.#policy.evaluate({ tool, shell, argv });

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

    if (humanConfirmed) {
      return {
        allowed: true,
        policy,
        human_confirmed: true,
      };
    }

    if (policy.effect === "allow") {
      if (requirePolicyApproval) {
        throw new AgentDockError(
          "HOST_COMPAT_APPROVAL_POLICY_REQUIRED",
          "Legacy host confirmation requires an explicit ask policy for this operation.",
          { tool, rule_id: policy.rule_id },
        );
      }
      return { allowed: true, policy };
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

    const mutation = this.#tasks.mutate(taskId, (task) => {
      ensureApprovalState(task);
      assertTaskActive(task);

      const taskGrant = task.approval_grants.find(
        (grant) =>
          grant.kind === "ALLOW_TASK" &&
          grant.approval_scope === policy.approval_scope,
      );
      if (taskGrant) {
        return {
          kind: "allowed",
          grant: taskGrant,
          request: null,
          created: false,
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
        task.updated_at = new Date().toISOString();
        return {
          kind: "allowed",
          grant,
          request: null,
          created: false,
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
        return {
          kind: "required",
          grant: null,
          request: existing,
          created: false,
        };
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
      task.updated_at = now;
      return {
        kind: "required",
        grant: null,
        request,
        created: true,
      };
    });

    const outcome = mutation.result;
    if (outcome.kind === "allowed") {
      return {
        allowed: true,
        policy,
        grant: outcome.grant,
      };
    }

    if (outcome.created) {
      this.#audit?.append(taskId, {
        event: "APPROVAL_REQUESTED",
        approval_id: outcome.request.approval_id,
        rule_id: outcome.request.rule_id,
        approval_scope: outcome.request.approval_scope,
        tool: outcome.request.tool,
        operation: outcome.request.operation,
        status: outcome.request.status,
        created_at: outcome.request.created_at,
      });
    }

    throw new AgentDockError(
      "APPROVAL_REQUIRED",
      "Operation requires approval before execution.",
      { approval_request: outcome.request },
    );
  }

  get({ taskId, approvalId }) {
    const task = this.#tasks.get(taskId);
    ensureApprovalState(task);
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
    if (!DECISIONS.has(decision)) {
      throw new AgentDockError(
        "INVALID_APPROVAL_DECISION",
        "Unsupported approval decision: " + decision,
      );
    }

    const mutation = this.#tasks.mutate(taskId, (task) => {
      ensureApprovalState(task);
      assertTaskActive(task);

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
        task.updated_at = now;
        return {
          approval,
          grant: null,
          responded_at: now,
        };
      }

      if (decision === "DENY") {
        approval.status = "DENIED";
        approval.resolved_at = now;
        task.updated_at = now;
        return {
          approval,
          grant: null,
          responded_at: now,
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
      task.updated_at = now;
      return {
        approval,
        grant,
        responded_at: now,
      };
    });

    const result = mutation.result;
    this.#audit?.append(taskId, {
      event: "APPROVAL_RESPONDED",
      approval_id: approvalId,
      decision,
      status: result.approval.status,
      ...(result.grant
        ? {
            grant_id: result.grant.grant_id,
            approval_scope: result.grant.approval_scope,
          }
        : {}),
      responded_at: result.responded_at,
    });

    return {
      approval: result.approval,
      grant: result.grant,
    };
  }
}
