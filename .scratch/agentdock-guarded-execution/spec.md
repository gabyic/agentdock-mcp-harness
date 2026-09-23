# AgentDock Guarded Execution Spec

Status: ready-for-agent  
Prototype source: `prototype/guarded-execution` @ `baee793`

## Problem Statement

AgentDock can already act as a remote coding harness, but the global audit found that its current safety and durability guarantees are weaker than its product language implies.

Routine coding and privileged host operations share the same execution path. Most `process.start` calls are effectively default-allow in production, absolute host file writes bypass approval policy entirely, and the service account has passwordless sudo. Smart Approval is useful as a model review loop, but it is not a technical privilege boundary.

Separately, Task and Guided Workflow completion can claim success without durable evidence. Detached-worktree commits are not retained by an AgentDock-owned Git ref, Workflow can reach DONE without verified Task/commit/test/review evidence, JSON workflow state can lose concurrent updates across the two production Node runtimes, and process output/state persistence can retain secrets or consume unbounded memory.

The user needs AgentDock to remain highly autonomous for ordinary coding while making host/privileged actions genuinely bounded, durable, auditable, and fail-closed.

## Solution

Introduce a Guarded Execution architecture with four primary seams:

1. **Execution seam**
   - Routine Task processes run through a Workspace Execution adapter.
   - Host/privileged operations run through a Host Execution adapter.
   - Workspace execution can be OS-sandboxed without changing the normal coding tool surface.
   - Host escalation uses explicit confirmation rather than shell-command guesswork.

2. **State seam**
   - Durable mutable state moves behind one transactional StateStore interface.
   - SQLite is the canonical mutable store for cross-process state.
   - Large process output and Git/worktree data remain outside SQLite.
   - Migration from existing JSON state is explicit, one-way, and observable.

3. **Evidence seam**
   - Workflow phase transitions that claim implementation/review completion require durable evidence.
   - Task outcomes are first-class: COMMIT, NO_CHANGE, FAILED, ABORTED.
   - Review completion is attached to a specific implementation target.
   - DONE is computed from evidence, not solely from a model-issued phase event.

4. **Git retention seam**
   - Finished Task commits are anchored by AgentDock-owned Git refs before worktree cleanup.
   - Cleanup never removes the last durable ref to a finished commit.
   - A later archive/release path may drop the AgentDock ref only after another durable ref contains the commit.

The rollout must preserve current production behavior by default. Guarded execution is introduced behind explicit modes so the new boundary can be observed before enforcement.

## User Stories

1. As an AgentDock user, I want normal code reading, editing, testing, linting, building, and local commits to continue without repeated approvals, so that security hardening does not destroy autonomous coding throughput.
2. As an AgentDock user, I want Task processes to be technically prevented from writing outside their allowed workspace when guarded execution is enforced, so that a prompt-injected script cannot modify unrelated host files.
3. As an AgentDock user, I want sandboxed Task processes to be unable to gain additional privileges, so that passwordless sudo on the host is not inherited as an unrestricted capability.
4. As an AgentDock user, I want network access to be an explicit Workspace execution capability rather than an accidental default, so that outbound data access is visible and controllable.
5. As an AgentDock user, I want selected sensitive host paths hidden from sandboxed processes, so that credentials are not readable merely because the AgentDock OS user can read them.
6. As an AgentDock user, I want operations that intentionally act on the host to remain possible, so that AgentDock can still inspect logs, restart services, deploy, and maintain production systems.
7. As an AgentDock user, I want privileged host actions to require explicit confirmation when they cross a configured risk boundary, so that ordinary coding remains automatic while dangerous effects are deliberate.
8. As an AgentDock user, I want modern MCP clients to use MCP-native multi-round-trip confirmation, so that confirmation happens inside the original action instead of through an unrelated approval tool call.
9. As an AgentDock user, I want clients that cannot complete MCP elicitation to fail closed or use the existing compatibility approval workflow, so that unsupported clients never silently auto-approve.
10. As an AgentDock user, I want the existing Smart Approval model review loop to remain available for medium-risk decisions, so that not every action requires a human click.
11. As an AgentDock user, I want a clear distinction between model review and mandatory human confirmation, so that the UI and audit trail do not overstate the strength of Smart Approval.
12. As an AgentDock user, I want host file writes to go through the same Host Execution authorization seam as privileged processes, so that absolute paths cannot bypass policy.
13. As an AgentDock user, I want Guarded Execution to support observe mode before enforcement, so that production command patterns can be classified without breaking live workflows.
14. As an AgentDock user, I want enforcement to fail closed when the configured sandbox runtime is missing or known-unsafe, so that a broken sandbox never silently becomes unrestricted execution.
15. As an AgentDock maintainer, I want sandbox runtime version requirements to be validated explicitly, so that vulnerable bubblewrap versions cannot be treated as a security boundary.
16. As an AgentDock maintainer, I want the execution policy concentrated behind one module interface, so that shell/process/file callers do not each implement their own incomplete safety rules.
17. As an AgentDock maintainer, I want two real execution adapters at that seam, so that workspace execution and host execution can evolve independently without duplicating callers.
18. As an AgentDock user, I want every finished Task with code changes to retain a durable Git ref, so that cleanup and later Git GC cannot delete the only copy of the result.
19. As an AgentDock user, I want NO_CHANGE to be a valid Task outcome, so that investigation-only work does not need a fake commit to be considered complete.
20. As an AgentDock user, I want Task finish to record an explicit outcome and evidence, so that a clean worktree alone is not sufficient proof of completed coding work.
21. As an AgentDock user, I want Task cleanup to be safe after completion, so that removing a worktree never destroys the durable result.
22. As an AgentDock maintainer, I want a future archive action to release AgentDock Git refs only after another durable ref contains the commit, so that retained refs do not grow forever.
23. As an AgentDock user, I want Workflow implementation completion to require linked Task outcomes, so that Workflow cannot advance based on an unsupported model assertion.
24. As an AgentDock user, I want multi-ticket workflows to support multiple implementation Tasks, so that one Workflow is not artificially limited to one Task.
25. As an AgentDock user, I want review evidence tied to a concrete target commit or implementation set, so that a review cannot be reused for different code.
26. As an AgentDock user, I want REVIEW to remain blocked while required review evidence is missing or has blocking findings, so that DONE has a durable meaning.
27. As an AgentDock user, I want legitimate NO_CHANGE implementation units to satisfy the Workflow only when they include a recorded reason/evidence, so that evidence gating does not incentivize empty commits.
28. As an AgentDock maintainer, I want Task, Process, Approval, Audit, and Workflow mutable state to share one transactional storage seam, so that cross-runtime updates do not silently overwrite each other.
29. As an AgentDock maintainer, I want concurrent writes from the stdio/OAuth runtime and native HTTP runtime to serialize safely, so that the system remains correct under real MCP concurrency.
30. As an AgentDock maintainer, I want SQLite to be used through Node's built-in `node:sqlite`, so that the state fix does not add a new npm database dependency.
31. As an AgentDock maintainer, I want the database to use WAL and explicit busy handling, so that readers and writers can coexist without inventing a filesystem lock protocol.
32. As an AgentDock user, I want existing JSON state to be imported once with clear migration status, so that upgrading does not orphan existing Tasks and audit history.
33. As an AgentDock maintainer, I want migration to be idempotent and resumable, so that a crash during migration cannot partially corrupt both stores.
34. As an AgentDock user, I want process output memory to be bounded, so that chatty tests or coding workers cannot consume the AgentDock service memory limit indefinitely.
35. As an AgentDock user, I want output cursor semantics to remain correct after truncation, so that clients can detect when old output is no longer available.
36. As an AgentDock user, I want persisted command/output previews to be redacted and bounded, so that durable state does not casually retain credentials.
37. As an AgentDock maintainer, I want raw live output to remain available while AgentDock owns the process, so that debugging is still useful during the active session.
38. As an AgentDock user, I want stale ACTIVE Tasks to be discoverable, so that long-running use does not leave an invisible pile of abandoned worktrees.
39. As an AgentDock user, I want cleanup of stale Tasks to remain explicit rather than automatic, so that AgentDock never deletes work based only on age.
40. As an AgentDock maintainer, I want production source control to have one reconciled source of truth, so that local production commits and remote release hardening cannot diverge unnoticed.
41. As an AgentDock maintainer, I want release and CI hardening from the remote main line preserved while Guarded Execution is developed, so that security work does not regress release integrity.
42. As an AgentDock user, I want Guarded Execution disabled by default until its production prerequisites pass, so that the new architecture can be implemented without silently changing live behavior.
43. As an AgentDock operator, I want doctor diagnostics to report guarded-execution mode, sandbox readiness, state backend, migration status, and unsafe prerequisites, so that deployment health is inspectable.
44. As an AgentDock operator, I want observe mode telemetry to say what would have been sandboxed, confirmed, denied, or escalated, so that enforcement policy can be tuned from real usage.
45. As an AgentDock user, I want existing 2025-era MCP compatibility to remain functional where possible, so that hardening does not unnecessarily break older clients.
46. As an AgentDock user, I want modern 2026-07-28 clients to receive the stronger MRTR confirmation path, so that newer clients get the best available safety semantics.
47. As an AgentDock maintainer, I want full black-box tests at the MCP seam, so that safety behavior is validated where real clients observe it rather than through implementation-only unit tests.
48. As an AgentDock maintainer, I want each high-risk regression found by the audit represented by a failing test before its fix, so that the audit becomes durable engineering knowledge.
49. As an AgentDock operator, I want no production deployment until the full regression suite and code review pass, so that the security repair itself cannot become an unreviewed production change.
50. As an AgentDock user, I want the architecture to remain Linux-first and self-hosted, so that Guarded Execution does not become a SaaS control plane or a second AI runtime.

## Implementation Decisions

- Add one deep Execution module seam. Callers submit an execution intent; the module chooses the Workspace or Host adapter and owns sandboxing/escalation behavior.
- Workspace Execution is the default autonomous lane for relative Task worktree processes. In enforce mode it runs under an OS sandbox with the Task worktree writable and the host root read-only.
- The sandbox policy must set no-new-privileges, drop capabilities, isolate process/user namespaces, provide an isolated temporary home, and support default network isolation.
- Sensitive host paths are hidden or replaced inside the sandbox according to configuration.
- The production sandbox runtime must satisfy an explicit minimum supported version. The validated prototype used bubblewrap semantics, but the installed production bubblewrap 0.9.0 is not an acceptable enforcement runtime because upstream fixed a sandbox-escape issue in 0.12.0.
- Guarded Execution has three modes: off, observe, enforce. Off preserves current behavior. Observe records the decision that enforce would make but executes through the legacy path. Enforce applies the new boundary.
- Host Execution covers intentional absolute-host operations and privileged effects. It is not inferred by parsing arbitrary shell semantics after execution begins.
- Modern MCP human-required operations use 2026-07-28 `input_required` elicitation and retry the original tool call after accepted confirmation.
- A client that lacks the required elicitation capability must never cause the privileged action to execute. Compatibility may use the existing durable Approval flow where the caller explicitly completes it.
- Smart/model approval remains a separate review level and must not be described as mandatory human confirmation.
- Host absolute file mutation must pass through the same host authorization seam before any parent directory or file side effect occurs.
- Task process execution and host file operations must share authorization vocabulary so audit logs use the same scope/result terms.
- Git Task completion must create or update an AgentDock-owned ref under a dedicated namespace before the Task can become COMPLETED.
- Worktree cleanup preserves that AgentDock ref.
- Task completion records an explicit outcome. COMMIT requires durable commit evidence. NO_CHANGE requires a non-empty reason/evidence. FAILED and ABORTED are terminal but do not satisfy implementation-complete evidence.
- Workflow tracks a set of implementation units rather than a single Task.
- Workflow implementation completion is computed from implementation-unit evidence. Each required unit must be terminal with an accepted outcome.
- Workflow review evidence identifies the reviewed target and separate Standards/Spec results. REVIEW cannot advance to DONE while blocking findings remain or required evidence is absent.
- Durable mutable state is hidden behind a StateStore interface with SQLite as the canonical production adapter.
- SQLite uses built-in `node:sqlite`, WAL, busy timeout, foreign keys, transactions, and schema migrations.
- Existing JSON files are treated as legacy import input, not a second long-lived source of truth.
- Migration records its own schema version and import markers so restart/retry is idempotent.
- Process output uses a byte-bounded in-memory ring while live. Cursor floor advances when old chunks are evicted.
- Durable process state stores bounded/redacted command and output summaries rather than assuming raw command/output is safe to persist.
- Large stdout/stderr blobs stay out of SQLite.
- Task discovery is added so ACTIVE/stale/finalized-unleaned Tasks are visible without filesystem inspection. Cleanup remains explicit.
- Doctor reports source-control/guarded-execution/state-backend prerequisites relevant to safe operation.
- Reconcile the current local main and origin/main before release/promotion so remote immutable-release hardening and local v0.3/v0.4 changes share one history.
- No production enforcement is enabled as part of implementation unless the secure sandbox runtime prerequisite passes and the user separately approves rollout.

## Testing Decisions

- Prefer MCP black-box tests as the highest seam for behavior visible to ChatGPT/Claude.
- Add regression tests for the exact audit failures before implementing each fix.
- Execution tests must prove both positive and negative behavior: normal workspace build/test succeeds; outside write fails; sensitive path access fails; network follows configured policy; unsafe sandbox version fails closed in enforce mode.
- MRTR tests must exercise a 2026-07-28 Streamable HTTP client with elicitation support and a client without elicitation support. The unsupported path must prove the action did not execute.
- Compatibility approval tests must remain for older/non-interactive clients.
- Git retention tests must finish a detached-worktree Task, cleanup the worktree, expire reflogs/run Git GC, and prove the final commit remains reachable through the AgentDock ref.
- Task outcome tests must prove an untouched clean Task cannot masquerade as a completed code-change Task, while a deliberate NO_CHANGE result can complete with evidence.
- Workflow tests must prove implementation_complete and review_passed fail without evidence and succeed with valid linked evidence.
- Concurrency tests must use two independent Node processes against the same state database and prove no lost update.
- Migration tests must cover first import, restart, repeated import, partial migration failure, and existing JSON state.
- Process-output tests must exceed the memory bound and verify cursor-floor/truncation semantics while preserving latest output.
- Redaction tests must place canary credentials in env, command arguments, shell text, stdout, and stderr and verify durable state does not retain the raw value.
- Task discovery tests must surface stale ACTIVE Tasks but never auto-delete them.
- Existing Ticket 01–08, v0.2, v0.3, protocol, release, and service lifecycle tests remain required regression coverage.
- Release verification/build/smoke and a final two-axis code review are mandatory before any production deployment.

## Out of Scope

- Windows support.
- A SaaS relay/control plane, billing, organizations, or public Plugin monetization.
- A new server-side reasoning model.
- A heavy custom privilege broker.
- Automatically granting network access to all sandboxed tasks.
- Automatic deletion of stale Tasks based only on age.
- Automatically enabling production enforce mode.
- Replacing Git worktrees with containers.
- Storing arbitrary large process output in SQLite.
- Solving every possible secret pattern through regex alone.
- Public OpenAI directory submission work.

## Further Notes

The validated prototype branch is `prototype/guarded-execution` at commit `baee793`.

Prototype A proved that the intended Workspace sandbox shape can run normal Node tests and workspace writes while the OS blocks writes outside the workspace, hides selected paths, blocks network, and sets NoNewPrivs.

Prototype B proved MCP 2026-07-28 MRTR confirmation end-to-end: a client with elicitation capability confirmed and retried the original tool call exactly once; a client without the capability failed with ProtocolError -32021 and the action did not execute.

Prototype C proved built-in Node SQLite cross-process concurrency using WAL: two independent Node processes performed 250 transactions each, producing 500/500 updates with zero lost updates and `PRAGMA integrity_check=ok`.

The current production host has bubblewrap 0.9.0. The implementation may support detection/observe mode immediately, but enforce mode must reject an unsafe runtime until a supported version is installed.

The current production repository history is also split: local main carries the AgentDock v0.3/v0.4 work while origin/main carries immutable-release hardening. Reconciliation is a prerequisite implementation ticket, not a reason to discard either side.
