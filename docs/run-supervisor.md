# Single Run Supervisor

AgentDock v0.4 introduces a single execution-owner seam for child processes.

## Roles

For a given authoritative state store, the first runtime in `execution.supervisor_mode=auto` becomes the **owner**. Later runtimes in the same host process become **clients** and delegate Run start/status/output/cancel operations to that owner.

Explicit modes:

- `auto` — become owner when none exists, otherwise become a client.
- `owner` — require ownership; fail closed if an owner already exists.
- `client` — require an existing owner; fail closed when none is available.

Environment override:

```text
AGENTDOCK_SUPERVISOR_MODE=auto|owner|client
```

The Supervisor is deliberately separate from Guarded Execution. Guarded Execution decides whether/how a command may launch; the Supervisor owns the child-process lifecycle.

## Safety invariants

- A persisted PID is diagnostic metadata, never authority to signal a process.
- Only a live in-memory child handle owned by the Supervisor may receive signals.
- A durable RUNNING record that claims the current runtime but has no in-memory child handle is reconciled to `INTERRUPTED`; AgentDock does not probe or signal the stored PID.
- A client runtime can cancel an owner Run through the Supervisor seam.
- Existing `run.start / run.get / run.cancel` and legacy `process.*` contracts remain unchanged.

## Deployment note

The in-process Supervisor registry is the v0.4 consolidation seam and removes duplicate execution ownership inside one AgentDock host process. Production currently still runs HTTP and stdio/OAuth entrypoints as separate systemd processes. Until those transports are converged behind one long-lived supervisor daemon/IPC endpoint, they must not both be configured as independent `owner` processes for the same state store.

The production rollout for Ticket 06 therefore assigns one process as owner and treats additional execution-capable transports as clients only after a shared IPC/daemon endpoint is available. Cross-process daemonization is intentionally not emulated by PID signalling.
