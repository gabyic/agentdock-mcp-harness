import { AgentDockError } from "./errors.js";

export const COMPLETION_EVIDENCE_KINDS = Object.freeze([
  "TARGETED_TESTS",
  "FULL_SUITE",
  "STATIC_CHECK",
  "DIFF_CHECK",
  "MIGRATION_CHECK",
  "PROVIDER_CHECK",
  "REVIEW",
]);

const ALLOWED_KINDS = new Set(COMPLETION_EVIDENCE_KINDS);

export function normalizeCompletionContract(value) {
  if (value == null) return null;
  const required = [...new Set((value.required ?? []).map((kind) => String(kind).trim().toUpperCase()))];
  for (const kind of required) {
    if (!ALLOWED_KINDS.has(kind)) {
      throw new AgentDockError(
        "INVALID_COMPLETION_CONTRACT",
        "Unsupported completion evidence kind: " + kind,
        { allowed_kinds: COMPLETION_EVIDENCE_KINDS },
      );
    }
  }
  if (required.length === 0) {
    throw new AgentDockError(
      "INVALID_COMPLETION_CONTRACT",
      "completion_contract.required must contain at least one evidence kind.",
    );
  }
  return { required };
}

export function assertEvidenceKind(kind) {
  const normalized = String(kind ?? "").trim().toUpperCase();
  if (!ALLOWED_KINDS.has(normalized)) {
    throw new AgentDockError("INVALID_COMPLETION_EVIDENCE_KIND", "Unsupported completion evidence kind.", {
      kind: normalized,
      allowed_kinds: COMPLETION_EVIDENCE_KINDS,
    });
  }
  return normalized;
}

export function evaluateCompletionEvidence(task, subjectSha) {
  const required = task.completion_contract?.required ?? [];
  const records = task.completion_evidence ?? [];
  const results = required.map((kind) => {
    const latest = [...records].reverse().find((record) => record.kind === kind) ?? null;
    let state = "MISSING";
    if (latest?.subject_sha === subjectSha) state = latest.status;
    else if (latest) state = "STALE";
    return { kind, state, evidence: latest };
  });
  return {
    required,
    subject_sha: subjectSha,
    satisfied: results.every((result) => result.state === "PASS"),
    results,
  };
}
