# Guarded Execution

AgentDock Guarded Execution separates routine autonomous coding from intentional host and privileged effects.

## Status

Introduced in 0.4.0-dev.2.

Production defaults remain conservative:

- state.backend = json
- guarded_execution.mode = off
- enforcement is not enabled automatically

## Execution model

### Workspace lane

Relative Task-worktree processes are Workspace execution. In enforce mode they run inside an OS sandbox with the host root read-only and the Task worktree read-write. Capabilities are dropped, process and user namespaces are isolated, HOME is temporary, network is denied by default, and configured sensitive paths are hidden.

Routine tests, builds, linters, compilers, Node/Python programs, and local tooling continue without repeated human confirmation as long as they stay inside the Workspace boundary.

### Host lane

Intentional host execution, including process.start with an absolute host cwd, remains possible. In enforce mode it requires explicit authorization.

Modern MCP 2026-07-28 clients use input_required elicitation. The original tool call executes only after the human accepts. Clients without elicitation capability fail closed.

The explicit confirmation_mode=legacy_approval compatibility path requires a deterministic Policy ask rule. Default-allow is not accepted as a compatibility confirmation. Deterministic deny remains authoritative even after human confirmation.

Absolute file.write and file.patch use the same Host confirmation rule before filesystem side effects occur.

## Modes

### off

Legacy execution behavior. Use this as the initial upgrade mode.

### observe

Legacy behavior remains unchanged, but AgentDock records what enforcement would do: Workspace would_sandbox and Host would_confirm.

### enforce

Workspace processes run in the sandbox and Host effects require confirmation. Enforce fails closed if Bubblewrap is missing or below the supported security baseline.

## Sandbox prerequisite

The minimum supported Bubblewrap version is 0.12.0.

The production server audited during development currently has Bubblewrap 0.9.0. Therefore enforce must remain disabled there until Bubblewrap is upgraded and agentdock doctor reports the sandbox ready.

Do not globally disable Ubuntu AppArmor user-namespace protections merely to make the sandbox work.

## State backend

0.4.0-dev.2 also introduces an optional transactional SQLite backend through AGENTDOCK_STATE_BACKEND=sqlite.

It uses Node built-in node:sqlite with WAL, foreign keys, busy timeout, explicit transactions, schema versioning, and idempotent legacy JSON import.

Task, persisted Process metadata, Approval, Audit, and Workflow mutable state share this transactional seam. Large output and Git/worktree data remain outside SQLite.

JSON remains the default backend in this development release.

## SQLite migration

SQLite is intentionally a canonical replacement, not a dual-write mirror.

Recommended migration:

1. stop AgentDock services or quiesce state-changing requests;
2. back up the complete state directory;
3. set AGENTDOCK_STATE_BACKEND=sqlite;
4. start one AgentDock runtime and let idempotent import complete;
5. run agentdock doctor and targeted resume/read checks;
6. start the second runtime;
7. verify concurrent Task and Workflow operations.

Do not operate JSON and SQLite as competing live writable backends.

## SQLite rollback

Do not roll back by merely changing AGENTDOCK_STATE_BACKEND=json after SQLite has accepted new writes, because the legacy JSON files are no longer current.

Safe rollback is to stop all runtimes, restore the pre-migration state-directory backup, set backend=json, restart, and verify. State created after the migration point must be reconciled separately if it must be preserved.

## Task evidence

COMMIT completion requires a real changed commit, final_commit_sha, and an AgentDock-owned durable ref under refs/agentdock/tasks/<task-id>. Cleanup preserves that ref, so Git GC cannot delete the only result.

NO_CHANGE is a first-class completion outcome and requires a non-empty reason or evidence rather than a fake commit.

## Guided Workflow evidence

A Workflow can link multiple implementation Tasks. implementation_complete requires every required unit to be a valid completed COMMIT or evidence-bearing NO_CHANGE.

Review evidence is tied to a fingerprint of the captured implementation set and records separate Standards and Spec results with blocking-finding counts. review_passed fails when evidence is missing, targets the wrong implementation snapshot, or contains a failed axis or blocking finding.

## Process and Task hygiene

Live process output is byte-bounded and retains cursor-floor semantics when old chunks are evicted. Durable command and output previews are bounded and redacted.

task.list makes ACTIVE, finalized, stale, and cleanup state discoverable. AgentDock never deletes stale Tasks based on age alone.

## Recommended production rollout

1. deploy code with backend=json and guarded execution off;
2. verify existing production workflows;
3. move Guarded Execution to observe;
4. inspect real audit decisions;
5. upgrade Bubblewrap;
6. verify sandbox readiness with agentdock doctor;
7. migrate to SQLite separately during a maintenance window;
8. validate MRTR confirmation with the actual ChatGPT connector;
9. only then make a separate decision about enforce.

## Non-goals

This work does not add a second server-side LLM, SaaS control plane, billing, a custom root privilege broker, automatic stale-task deletion, or automatic production deployment.
