# Service Lifecycle Hardening

AgentDock v0.2 defines explicit service lifecycle semantics for long-running Linux deployments.

The recommended production shape for Core is native Streamable HTTP on loopback, supervised by systemd, with authenticated TLS ingress in front.

## Why this exists

The live v0.1 acceptance found a real operational failure mode:

```text
Restart=on-failure
+
clean SIGTERM
=
service exits successfully
=
systemd does not restart it
```

v0.2 fixes that contract instead of treating reconnect as an application-only problem.

## Service state contract

### Planned shutdown / restart

Examples:

```bash
systemctl --user restart agentdock-http.service
kill -TERM <agentdock-main-pid>
```

When AgentDock receives SIGTERM or SIGINT:

1. HTTP stops accepting new requests;
2. AgentDock terminates Process groups it currently owns;
3. those Process records become `CANCELLED`;
4. transports close;
5. AgentDock exits successfully.

The audit contains a `PROCESS_CANCEL_REQUESTED` entry with:

```text
reason=service_shutdown
```

A subsequent AgentDock instance can resume the durable Task without pretending those Processes are still running.

### Unexpected crash

Examples include:

- SIGKILL;
- runtime crash;
- OOM termination;
- host/service-manager interruption before AgentDock can run cleanup.

There is no application-level cleanup opportunity.

The hardened systemd unit uses:

```ini
KillMode=control-group
```

so detached Task subprocesses remain in the service cgroup and are cleaned with the failed service.

Current AgentDock releases persist an execution-owner lease for every running Run/process.

A second live AgentDock runtime that reads the same durable state does **not** rewrite a remotely owned `RUNNING` process. It reports remote ownership and observes the durable record until the real owner publishes a terminal state.

A stale heartbeat by itself is not enough to corrupt process state. If the recorded owner PID is still alive, the observer keeps the process active and reports the stale owner lease.

Only when execution ownership is actually lost does AgentDock reconcile a persisted `RUNNING` or `CANCELLING` record to:

```text
INTERRUPTED
```

with the durable reason:

```text
AgentDock restarted or lost ownership of the running process.
```

This distinction is deliberate:

```text
CANCELLED   = AgentDock intentionally terminated a Run/process.
INTERRUPTED = AgentDock actually lost execution ownership.
REMOTE      = another live AgentDock runtime currently owns execution.
```

### Idempotent Run start and transport retries

A remote client may lose the response to a mutating request even though AgentDock already accepted it. Retrying the same command without a durable identity would otherwise create a second Run and repeat side effects.

`run.start` and the compatibility `process.start` therefore accept an optional:

```text
idempotency_key
```

For a given Task and start tool:

- the first request binds the key to a request fingerprint and one durable Run;
- an in-flight or terminal retry with the same key and same request returns that original Run;
- the binding survives AgentDock runtime restart;
- the same key with different arguments fails closed with `IDEMPOTENCY_KEY_REUSED`;
- the raw key is not persisted; AgentDock stores a hashed operation id and request fingerprint.

Callers should generate one stable key per logical mutating action and reuse it only when retrying that exact action.

The built-in retention policy keeps terminal idempotency records for up to **7 days** and caps the operation set at **5,000 records**. Old terminal records are eligible for pruning. Non-terminal records are never discarded merely to make space; if the cap is filled by non-terminal operations, new idempotent starts fail closed rather than silently losing deduplication state.

A narrow claim-to-process persistence window is also fail-closed. If a retry sees the durable operation before the original Run record is visible, AgentDock reports `IDEMPOTENCY_OPERATION_PENDING`; the caller should retry with the same key. It must not create a replacement Run with another key unless the human intentionally wants a second side effect.

## Health command

For HTTP deployments:

```bash
agentdock health
```

Explicit endpoint:

```bash
agentdock health --url http://127.0.0.1:3100/healthz
```

Machine-readable:

```bash
agentdock health --json
```

Startup/recovery gate:

```bash
agentdock health --wait-ms 10000 --timeout-ms 1000
```

`--wait-ms` retries until the endpoint becomes healthy or the deadline expires.

Exit codes:

- `0`: healthy;
- `1`: unhealthy / configuration error;
- `2`: CLI usage error.

The health check requires the endpoint to return HTTP success with:

```json
{
  "status": "ok",
  "transport": "streamable-http"
}
```

## Hardened systemd user unit

The repository ships:

```text
deploy/systemd/agentdock-http.service
```

The contract is automatically validated by:

```bash
npm run service:verify
```

Critical properties:

```ini
Environment=AGENTDOCK_TRANSPORT=http
Restart=always
RestartSec=2
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
FinalKillSignal=SIGKILL
TimeoutStopSec=15
UMask=0077
```

Startup is gated by:

```ini
ExecStartPost=%h/.local/bin/agentdock health --wait-ms 10000 --timeout-ms 1000
```

### Why `Restart=always`

It restarts AgentDock after both abnormal failure and a clean direct SIGTERM.

An explicit `systemctl --user stop ...` is still an operator stop request; systemd does not treat that as a reason to immediately restart the unit.

### Why `KillMode=control-group`

AgentDock Process execution intentionally uses detached Unix process groups. Detached does not remove those descendants from the systemd service cgroup.

`KillMode=control-group` makes the service manager responsible for cleaning all remaining descendants when the service stops/crashes.

Do not change this to `process` or `none`.

## Install the user unit

For a default managed installation:

```bash
mkdir -p ~/.config/systemd/user
cp ~/.local/share/agentdock-mcp-harness/deploy/systemd/agentdock-http.service \
  ~/.config/systemd/user/agentdock-http.service

systemctl --user daemon-reload
systemctl --user enable --now agentdock-http.service
```

Check:

```bash
systemctl --user status agentdock-http.service
agentdock health
```

If your launchers are not in `~/.local/bin`, edit `ExecStart` and `ExecStartPost` accordingly.

To keep a user service running after logout, the host may require user lingering to be enabled by the operator/administrator.

## Optional service environment overrides

The unit loads this file if present:

```text
~/.config/agentdock/service.env
```

Example:

```bash
AGENTDOCK_HTTP_PORT=3100
AGENTDOCK_HTTP_HOST=127.0.0.1
```

Do not put secrets in a world-readable file. Normal AgentDock config/env precedence still applies.

## Durable deterministic Plans

Long deterministic verification chains should not depend on a ChatGPT response stream remaining connected.

The v0.4 Plan Runner exposes:

```text
plan.start
plan.get
plan.cancel
plan.continue
```

A Plan is a dependency-aware set of deterministic steps. `plan.start` requires an `idempotency_key`, persists the Plan, returns immediately, and lets the leased Plan driver continue in the background. Each command step starts its Run with a stable internal idempotency key, so an exact Plan retry does not repeat the side effect.

Successful Plans without an explicit finish action stop at:

```text
READY_TO_COMMIT
```

Plans never infer commit or finish actions. When the caller explicitly declares guarded `GIT_COMMIT` and `TASK_FINISH` steps, those actions enforce clean-worktree, retained-commit, outcome, and Completion Contract rules before advancing.

A failed, cancelled, interrupted, or timed-out step stops the Plan at:

```text
AWAITING_ASSISTANT
```

Later steps are not executed. AgentDock does not invent a repair and does not invoke a hidden LLM.

Existing `task.resume` includes the latest Plan summary without changing its input schema. While a Plan runs it returns `WAIT_FOR_PLAN`; when deterministic execution needs reasoning it returns `ASSISTANT_REQUIRED`.

Plans intentionally do not persist custom `env` values. Secret-bearing one-off environments must use an explicitly approved `process.start` call rather than becoming part of durable Plan state.

Full Plans persist stable step ids, per-step idempotency keys, dependencies, exit-code success criteria, bounded retry policy, evidence records, and explicit blocker semantics. Deterministic command steps can feed Completion Contract evidence; `GIT_COMMIT` and `TASK_FINISH` provide guarded terminal actions. Reasoning, human confirmation, and policy approval boundaries stop durably and require an explicit continuation after the barrier is resolved.

Plan drivers use a short durable lease so HTTP and MCP transports cannot both advance the same Plan. After a transport restart, a new driver takes over while the Single Run Supervisor retains ownership of any child process. A failed or ambiguous step is never auto-continued, and AgentDock contains no server-side LLM or hidden repair loop.

## Durable Task completion outcomes

`task.finish` now records one of two durable outcomes:

- `COMMIT` — the Task produced a commit newer than its base HEAD. Before the Task becomes `COMPLETED`, AgentDock anchors that commit under `refs/agentdock/tasks/<task_id>` and stores the retention ref with the Task.
- `NO_CHANGE` — the Task produced no new commit. This outcome must be explicit and requires a non-empty reason/evidence.

A clean Task with no new commit cannot silently become completed. Conversely, `NO_CHANGE` cannot hide a new commit.

When `task.create` declares a Completion Contract, `task.finish` additionally requires a current PASS record for every declared evidence kind. Each `task.evidence.record` entry is bound to the Task worktree's current commit, so a later commit makes older evidence stale. A known FAIL, missing evidence, or stale evidence cannot produce `verification_status: VERIFIED`. `NO_CHANGE` follows the same evidence gate and still requires its explicit reason. Tasks without a caller-defined contract remain lifecycle-compatible and finish as `NOT_REQUIRED`, never as `VERIFIED`.

`task.cleanup` verifies COMMIT retention before removing the worktree. If the durable ref is missing or points somewhere else, cleanup fails closed. This preserves the delivered commit through worktree removal, reflog expiry, and ordinary/aggressive Git garbage collection.

Historical completed Tasks that contain a commit newer than their base HEAD but predate retention metadata are also treated conservatively: cleanup refuses until their result is reconciled instead of risking deletion of the only remaining commit object.

## Secure durable output and Task hygiene

Live Run/process output remains faithful for the currently connected runtime. Before Process state is persisted, AgentDock applies best-effort redaction to command arguments/shell, environment, stderr/stdout diagnostic chunks, cwd, and error text. Sensitive environment values are also treated as redaction canaries inside persisted command/output text. The durable diagnostic tail remains bounded by the existing Process output retention limit.

SQLite schema v2 rewrites existing authoritative Process documents through the same redaction seam and sanitizes Process records during legacy JSON import. The legacy JSON rollback files themselves are left byte-for-byte unchanged. Historical redaction is necessarily best-effort: an old opaque value that was persisted without a recognizable secret key/prefix and whose original secret value is no longer available cannot be reconstructed and identified reliably.

`task.list` is a read-only hygiene view. It reports:

- lifecycle state and completion outcome;
- last meaningful activity time/age using Task, Process, and Plan activity;
- active Run ids and current Plan status;
- pending approvals/blockers;
- worktree presence and approximate byte usage;
- stale / needs-attention status;
- aggregate AgentDock state/worktree usage and orphan-worktree counts.

A stale ACTIVE Task is only surfaced as needing attention. Ticket 05 performs **no automatic cleanup, cancellation, GC, or age-based deletion**.

## Truthful Task activity

Workspace Task lifecycle remains deliberately small: `ACTIVE`, `COMPLETED`, or `CANCELLED`. `task.resume` and `task.list` derive a separate `activity_state` from authoritative Task, Run, Plan, approval, and Git facts:

```text
EXECUTING
VERIFYING
AWAITING_APPROVAL
AWAITING_USER
AWAITING_ASSISTANT
INTERRUPTED
READY_TO_COMMIT
READY_TO_FINISH
TERMINAL
```

The same derivation supplies `current_blocker`, `recommended_next_action`, and `last_meaningful_progress_at`. An active Run or Plan represents real execution; otherwise approval/user blockers outrank commit/finish readiness. Failed Plans and interrupted Runs surface the reasoning barrier instead of pretending the Task is merely idle.

Observational calls are observational: `task.resume`, `task.list`, `process.status`, `run.get`, `plan.get`, `approval.get`, and `audit.get` do not append ordinary business-audit progress or advance the Task's `updated_at`. Repeated reads therefore cannot make a stale Task look active.

## Test contract

v0.2-06 black-box coverage verifies:

- planned SIGTERM exits cleanly;
- owned Task Process is actually terminated;
- planned Process state restores as `CANCELLED`;
- audit records `reason=service_shutdown`;
- health endpoint goes down and comes back;
- a new MCP client can reconnect and list all tools;
- hard crash recovery restores lost Process ownership as `INTERRUPTED`;
- the systemd unit cannot regress to `Restart=on-failure`;
- the systemd unit keeps `KillMode=control-group`;
- the startup health gate retries while the service is still coming up.

## Existing reverse proxy / OAuth deployments

AgentDock Core does not replace OAuth/TLS ingress.

If an external MCP/OAuth proxy owns the public socket, supervise that proxy separately and ensure its own restart policy is correct.

The native HTTP systemd unit covers the recommended Core process itself.
