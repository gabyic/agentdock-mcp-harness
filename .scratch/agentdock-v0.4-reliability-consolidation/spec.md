# AgentDock v0.4 Reliability Consolidation Spec

**Status:** ready-for-agent after ticket breakdown approval  
**Date:** 2026-09-25  
**Baseline:** current `main` with Execution Reliability v2  
**Source material:** production audit, repeated long-running Task incidents, and selectively reusable work from `feature/guarded-execution`

## Problem Statement

AgentDock can now keep long-running Linux execution alive, bound MCP output, resume durable Tasks, and avoid one previously reproduced Process split-brain failure. However, the production system still lacks one authoritative model for Task state, execution ownership, retries, completion evidence, and long-running orchestration.

This creates several user-visible and correctness failures:

- A coding Task can remain silent for hours even though each individual command completes in under a minute because orchestration stops when the ChatGPT turn disappears.
- Two AgentDock runtimes can overwrite each other's Task mutations.
- A stale runtime can resurrect a Task that another runtime already marked COMPLETED.
- A retried mutating request can execute the same side effect more than once.
- A Task can be marked COMPLETED even when its project tests are known to fail.
- A completed detached commit can become unreferenced after worktree cleanup and later be deleted by Git garbage collection.
- A pending approval is not represented as the actual blocker in `task.resume`.
- Durable Process state can contain secrets printed to stdout/stderr.
- Stale Tasks accumulate indefinitely and consume disk while the ACTIVE state does not distinguish executing work from abandoned or blocked work.
- Multi-runtime Process control remains fragmented: one runtime may observe a Run but be unable to control it safely.

The audit reproduced these failures against the current production baseline rather than inferring them from code alone.

The desired result is not a second autonomous coding agent. ChatGPT remains the reasoning agent. AgentDock remains the deterministic execution harness. The change is to make deterministic work durable, single-source-of-truth, idempotent, evidence-bearing, and resumable across ChatGPT/mobile/network interruptions.

## Solution

Consolidate the strongest parts of the current `main` and the proven parts of `feature/guarded-execution` into one v0.4 reliability architecture without directly merging the feature branch.

The consolidated design has four deep modules:

1. **Transactional State**
   - SQLite is the authoritative production durable-state backend.
   - Task, Approval, Audit, Workflow, Run metadata, idempotency records, Plan state, and completion evidence mutate transactionally.
   - Legacy JSON is migration/import input and an optional single-process development/test adapter, not a second production source of truth.
   - State callers do not retain stale mutable Task snapshots across requests.

2. **Run Supervisor**
   - Exactly one local execution owner manages child processes.
   - MCP/HTTP/stdio/tunnel integrations are transport adapters, not process owners.
   - Callers use the existing high-level Run contract: start, get, cancel.
   - Current bounded pagination, long-poll behavior, and compact output from Execution Reliability v2 are preserved.
   - Process identity is stronger than PID liveness alone; a stale durable record must never authorize signalling an unrelated reused PID/process group.
   - Cross-transport cancellation routes to the Supervisor instead of letting arbitrary runtimes signal Linux PIDs directly.

3. **Task / Plan Coordinator**
   - Workspace Task lifecycle and current activity are separate concepts.
   - Durable lifecycle remains small: ACTIVE, COMPLETED, CANCELLED.
   - Derived activity states explain what is actually happening: EXECUTING, AWAITING_ASSISTANT, AWAITING_APPROVAL, AWAITING_USER, VERIFYING, READY_TO_COMMIT, READY_TO_FINISH, INTERRUPTED.
   - `task.resume` is observational and reports the real blocker instead of manufacturing progress.
   - Task completion is evidence-bearing.
   - A deterministic Plan Runner can continue already-decided steps after the ChatGPT response stream disappears.
   - The Plan Runner stops at explicit reasoning or human boundaries; it never invents product/code decisions.

4. **Transport Adapters**
   - MCP stdio, native HTTP, OAuth/tunnel ingress, and future transports translate requests to the same Core interfaces.
   - Transport instances do not own authoritative Task state or child-process lifecycle.
   - Tool refresh and reconnects cannot change the semantic outcome of an operation.

The implementation reuses validated work from `feature/guarded-execution` selectively:

- transactional SQLite state;
- transactional durable-state callers;
- durable completed-Task Git retention;
- durable output redaction;
- stale Task discovery;
- evidence-gated completion concepts.

It explicitly does **not** import these unsafe or obsolete parts unchanged:

- JSON as the production authoritative backend;
- PID-liveness as proof of Process ownership;
- direct cross-runtime `kill(-pid)` control based only on a persisted PID;
- older unbounded Process output behavior;
- any implementation that replaces the current bounded `run.get` contract;
- any hidden autonomous reasoning loop.

## User Stories

1. As a ChatGPT user, I want an AgentDock Task to survive a mobile/network response interruption so that I do not lose work.
2. As a ChatGPT user, I want deterministic validation steps to continue after the response stream disappears so that a one-minute test does not turn into a six-hour idle gap.
3. As a ChatGPT user, I want AgentDock to stop when new reasoning is required so that deterministic execution never pretends to be an autonomous coding agent.
4. As a ChatGPT user, I want `task.resume` to tell me whether work is executing, waiting for approval, waiting for reasoning, ready to commit, or ready to finish so that ACTIVE is not ambiguous.
5. As a ChatGPT user, I want a retried request after a timeout to return the original Run instead of executing the same side effect twice.
6. As a ChatGPT user, I want two transports/runtimes to see one authoritative Task state so that updates cannot disappear.
7. As a ChatGPT user, I want a COMPLETED Task to stay terminal so that another stale runtime cannot resurrect it.
8. As a ChatGPT user, I want completion to mean that required evidence passed, not merely that a worktree is clean.
9. As a ChatGPT user, I want a legitimate NO_CHANGE investigation to finish without a fake commit while still carrying explicit evidence.
10. As a ChatGPT user, I want the final commit from a completed Task to remain reachable after cleanup and Git GC.
11. As a ChatGPT user, I want stale or abandoned Tasks to be discoverable without AgentDock silently deleting work.
12. As a ChatGPT user, I want old finalized Tasks and worktrees to be safely reclaimable so AgentDock does not continuously consume disk.
13. As a ChatGPT user, I want pending approvals to be shown as the real next blocker instead of receiving TASK_FINISH_REQUIRED.
14. As a ChatGPT user, I want reads/status checks to stay observational so checking progress does not mutate the same state it is measuring.
15. As a ChatGPT user, I want a Run started through one transport to be safely cancellable through another authorized transport.
16. As an operator, I want only one execution owner to signal child process groups so PID reuse cannot cause an unrelated process to be killed.
17. As an operator, I want Process output kept useful for live debugging without persisting raw credentials or unbounded transcripts.
18. As an operator, I want SQLite migrations/imports to be idempotent so switching from legacy JSON does not destroy existing durable Tasks.
19. As an operator, I want an explicit migration/rollback procedure so production can move to SQLite without losing auditability.
20. As an operator, I want health/doctor checks to report authoritative state-backend and Supervisor readiness so deployment failures are visible.
21. As a maintainer, I want one transactional state seam so Task, Approval, Audit, Workflow, Run, Plan, and idempotency changes share the same concurrency guarantees.
22. As a maintainer, I want transport adapters to be thin so future ChatGPT/MCP transports do not reimplement process/state semantics.
23. As a maintainer, I want every previously reproduced reliability bug locked by a deterministic regression test.
24. As a maintainer, I want the existing `run.start / run.get / run.cancel` contract and bounded-output behavior preserved through consolidation.
25. As a maintainer, I want Guarded Execution sandbox policy to remain separable from Run ownership so sandbox safety and lifecycle control do not become one overloaded module.
26. As a maintainer, I want the v0.4 reliability work to reuse proven feature-branch implementations where safe rather than reimplementing equivalent code from scratch.
27. As a maintainer, I want stale Task cleanup to be retention-aware so cleanup never discards the only durable reference to a delivered commit.
28. As a maintainer, I want deterministic Plans to expose their current step, last successful step, blocker, and evidence so long work remains auditable.

## Implementation Decisions

### 1. Preserve the current public Run contract

The current production `run.start / run.get / run.cancel` behavior is the compatibility anchor.

The consolidated implementation must preserve:

- asynchronous Run creation;
- bounded output pages;
- cursor-based incremental reads;
- long-poll bounded to a short timeout;
- compact Task resume summaries;
- legacy Process tools for compatibility until a later deprecation decision.

The consolidation may deepen the implementation behind this interface, but it must not regress the current response-size guarantees.

### 2. SQLite becomes the production authoritative durable-state backend

The built-in Node SQLite implementation proven on the feature branch is reused and rebased onto the current production baseline.

Production invariants:

- all mutable durable entities use one transactional state seam;
- SQLite uses WAL, foreign keys where relevant, busy timeout, explicit schema versioning, and deterministic migrations;
- cross-process mutation is serialized;
- every mutation observes the latest durable record inside the transaction;
- terminal Task states cannot transition back to ACTIVE;
- legacy JSON is imported idempotently;
- production does not continue writing JSON as a competing source of truth after cutover.

A JSON adapter may remain for tests or explicitly unsupported single-process development scenarios, but it is not a supported multi-runtime production mode.

### 3. Remove mutable Task object caching as an authority

A runtime may cache immutable projections for performance, but lifecycle mutations must always derive from the latest transactional record.

The Task interface performs atomic mutations and rejects illegal state transitions inside the same transaction.

This prevents both reproduced failures:

- concurrent process-id lost updates;
- COMPLETED Task resurrection from stale memory.

### 4. Add durable idempotency for mutating operations

Mutating execution-facing tools accept an optional operation/idempotency key.

For a key scoped to the relevant Task/tool:

- first use records request fingerprint and resulting durable operation/Run identity;
- exact retry returns the existing result/Run;
- same key with a different request fingerprint is rejected;
- terminal and in-flight retries are both deduplicated;
- the record survives transport reconnect/restart.

At minimum this applies to Run/Process start and other operations that can create duplicate external side effects.

### 5. Introduce one local Run Supervisor seam

The Run Supervisor is distinct from Guarded Execution policy.

The Supervisor owns:

- child-process launch lifecycle;
- process-group identity;
- cancellation/escalation;
- stdout/stderr live buffering;
- terminal reconciliation;
- durable Run metadata publication.

Transport runtimes call the Supervisor; they do not own children.

The Supervisor must not infer ownership from PID liveness alone.

A persisted PID/process-group identifier is diagnostic metadata, not sufficient authorization to signal a process.

Cross-transport cancellation is routed to the live Supervisor owner. If the owner is unavailable, AgentDock reports INTERRUPTED/owner unavailable; it does not signal an arbitrary currently-live PID based on stale state.

### 6. Keep Guarded Execution policy as a separate module

Guarded Execution decides **how/where a command may run**:

- Workspace vs Host;
- off/observe/enforce;
- sandbox readiness;
- network/hidden-path policy;
- human confirmation.

The Run Supervisor decides **who owns and controls execution**.

The two modules integrate through a launch plan but do not share lifecycle ownership responsibilities.

### 7. Make Task completion evidence-bearing

Task completion records an explicit outcome:

- COMMIT;
- NO_CHANGE.

COMMIT completion requires a retained final commit reference.

NO_CHANGE requires non-empty reason/evidence.

For implementation Tasks that claim verified completion, a Completion Contract defines required durable evidence such as:

- targeted tests;
- full test suite;
- static/compile checks;
- diff checks;
- migration/schema checks;
- project-specific provider/integration checks;
- review evidence.

The contract is supplied by the caller/workflow rather than hard-coding one universal `npm test`.

A Task can be lifecycle-terminal without claiming VERIFIED if its contract does not require verification, but user-facing workflow completion must never treat missing required evidence as success.

### 8. Retain completed commit evidence before worktree cleanup

Before a COMMIT Task becomes safely cleanable, AgentDock creates an AgentDock-owned durable Git ref pointing at the final commit and verifies it.

Worktree cleanup refuses to proceed when required retention evidence is absent.

Retention references may later be garbage-collected only under an explicit retention policy after the result is known to be promoted/merged/pushed or otherwise safely retained.

### 9. Separate lifecycle status from derived activity state

Durable lifecycle remains:

- ACTIVE;
- COMPLETED;
- CANCELLED.

Derived activity state is computed from authoritative state and recent execution/approval/plan facts:

- EXECUTING;
- AWAITING_ASSISTANT;
- AWAITING_APPROVAL;
- AWAITING_USER;
- VERIFYING;
- READY_TO_COMMIT;
- READY_TO_FINISH;
- INTERRUPTED;
- TERMINAL.

This prevents state explosion while making user-visible status useful.

`task.resume` must prioritize blockers correctly. Pending approval outranks READY_TO_FINISH. Active Plan/Run outranks idle status.

### 10. Make observational tools observational

Tools marked read-only do not append ordinary durable audit entries merely because they were read.

Read access may be measured through separate operational telemetry if needed, but querying status must not update the Task's business/audit timeline or last-progress calculation.

### 11. Add a deterministic durable Plan Runner

The Plan Runner executes only predeclared deterministic steps.

A Plan contains ordered/dependency-aware steps with:

- stable step id;
- operation/idempotency key;
- command/tool action;
- success criteria;
- evidence to record;
- blocker semantics;
- retry policy for explicitly safe/idempotent steps.

The Plan Runner may automatically move between deterministic steps.

It stops at:

- command/test failure requiring interpretation;
- approval/human confirmation;
- missing dependency;
- explicit reasoning barrier;
- unsafe/non-idempotent retry state.

It emits AWAITING_ASSISTANT rather than inventing a solution.

No server-side LLM is added.

### 12. Add Task hygiene without age-based destructive cleanup

A read-only Task listing/status interface exposes:

- lifecycle state;
- derived activity state;
- last meaningful progress;
- active Runs;
- pending approvals;
- worktree presence/size;
- retention evidence;
- stale-by-age indicator.

A reconciliation/GC path may safely clean:

- finalized Tasks whose retention guarantees are satisfied;
- cancelled clean Tasks under explicit policy.

ACTIVE stale Tasks are surfaced as NEEDS_ATTENTION and never auto-deleted solely because of age.

### 13. Durable output is diagnostic, bounded, and redacted

Live output remains available through the bounded Run cursor contract.

Persisted output is a bounded diagnostic preview.

Before persistence, command/env/stdout/stderr previews are redacted using the same canonical redaction policy.

The design must avoid persisting raw secrets merely because a child process printed them.

### 14. Selective feature-branch reuse, not branch merge

The consolidation is based on current production `main`.

The implementation selectively ports proven concepts/commits from `feature/guarded-execution` after adapting them to current interfaces:

- durable Task outcomes and Git retention;
- transactional SQLite StateStore;
- transactional state callers;
- durable output redaction/stale Task listing;
- completion/workflow evidence gates.

The following feature behavior is explicitly rejected:

- production JSON authoritative state;
- Process ownership defined by PID liveness;
- cancellation of externally observed Processes by directly signalling persisted PID/process-group ids;
- older output retrieval behavior that removes current v2 page limits;
- direct branch merge that overwrites the current Run v2 implementation.

### 15. Migration must be reversible before cutover

Production migration proceeds through an explicit cutover:

1. verify current JSON state parses cleanly;
2. create SQLite state store and schema;
3. idempotently import legacy state;
4. compare counts/identity for Tasks, Processes, Audits, Approvals, Workflows;
5. stop writers or enter maintenance window;
6. perform final import/check;
7. enable SQLite authoritative mode;
8. restart transports/Supervisor against the same authoritative store;
9. run smoke/regression tests;
10. retain legacy JSON read-only for rollback window.

Rollback before post-cutover mutation divergence may return to JSON. After authoritative SQLite mutations begin, rollback means restoring from a defined SQLite backup/export rather than treating old JSON as current truth.

## Testing Decisions

### Highest seams

Tests should prefer the highest seam that reproduces the user's real failure:

1. MCP/native HTTP end-to-end tool behavior for transport retry, resume, approval, and long-running Run behavior.
2. Multi-process integration tests for transactional state and Supervisor ownership.
3. Git integration tests for retention/cleanup/GC.
4. State module integration tests where concurrency cannot be exercised cleanly through MCP.
5. Unit tests only for pure state-transition helpers or redaction primitives.

Tests must assert external behavior, not internal implementation details.

### Required regression loops

The following reproduced bugs become permanent regression tests:

1. Two independent runtimes mutate one Task; neither process id is lost.
2. One runtime completes a Task; a stale runtime cannot start a new Run or return the Task to ACTIVE.
3. The same idempotency key retried for a mutating Run start produces one Run and one side effect.
4. A pending approval causes AWAITING_APPROVAL / approval-required next action, never TASK_FINISH_REQUIRED.
5. A read-only resume/status call does not create ordinary durable business/audit progress.
6. Cross-transport cancellation reaches the actual Supervisor-owned Run.
7. A stale Process record pointing at an unrelated live PID cannot cause that process to be signalled.
8. A completed COMMIT Task remains reachable after worktree cleanup, reflog expiry, and aggressive Git GC.
9. A known failing Completion Contract cannot be presented as verified completion.
10. Durable Process state does not contain stdout/stderr/env secret canaries.
11. Bounded Run output and cursor semantics from Execution Reliability v2 remain intact.
12. A deterministic Plan continues multiple passing steps after the initiating transport disconnects/reconnects.
13. A failing Plan step stops at AWAITING_ASSISTANT and does not continue to commit/finish.
14. Stale ACTIVE Tasks are discoverable but not auto-deleted.
15. Safe GC reclaims eligible finalized worktrees without deleting retained results.

### Existing prior art to preserve

The current release/service/restart/hard-crash/MCP protocol tests remain mandatory.

The proven v0.4 feature-branch tests for SQLite, retention, hygiene, and evidence gating should be ported/adapted rather than duplicated blindly.

### Acceptance bar

A ticket is not complete because code exists.

Each ticket must show:

- a pre-fix red-capable regression where applicable;
- passing targeted tests;
- existing relevant regression suites;
- no loss of current Run v2 behavior;
- clean diff/static validation;
- explicit end-to-end consumption by the next layer for any new interface.

## Out of Scope

- A second server-side LLM or autonomous coding agent.
- Redis, Celery, Kafka, Temporal, or distributed scheduler infrastructure.
- Multi-host distributed execution.
- SaaS billing, tenant RBAC, quotas, or membership systems.
- Automatic product/code decisions after a reasoning barrier.
- Replacing Git worktrees as the Workspace Task isolation model.
- Removing legacy Process tools in this spec.
- Completing the public ChatGPT directory submission/topology work.
- Merging `feature/guarded-execution` wholesale.
- Changing the Guarded Execution product policy beyond what is necessary to keep its seam separate from Run ownership.

## Further Notes

### Audit evidence captured before this spec

- Ticket 05 wall-clock duration was approximately 11 hours while its longest individual command was approximately 53 seconds.
- Its durable audit contained idle gaps of approximately 2h21m, 6h35m, and 1h04m.
- Production state contained roughly 150 Tasks, 2,195 Processes, 26 ACTIVE Tasks, zero active Processes at the audit instant, and 69 uncleaned Tasks/worktrees consuming roughly 555 MB.
- 23 ACTIVE Tasks had no meaningful progress for more than 24 hours.
- Current production Task state lost a concurrent update in a deterministic two-runtime repro.
- A stale runtime deterministically resurrected a COMPLETED Task to ACTIVE and successfully started a command.
- An identical retried mutating start deterministically executed the side effect twice.
- A pending approval deterministically produced the wrong TASK_FINISH_REQUIRED recommendation.
- Current cleanup allowed an otherwise completed detached commit to be removed by aggressive Git GC.
- Current durable Process JSON retained a stdout secret canary.
- The feature branch's SQLite mutation path preserved two concurrent updates while its JSON path still lost one.
- The feature branch's PID-liveness ownership approach deterministically killed an unrelated temporary process when given a stale record pointing at that live PID.

### Consolidation principle

Make the change easy, then make the easy change:

- first establish one authoritative transactional state seam;
- then establish one execution-ownership seam;
- then make lifecycle/activity/evidence truthful;
- only then add durable deterministic orchestration.

This ordering prevents an automated Plan Runner from amplifying inconsistent state or duplicate side effects.
