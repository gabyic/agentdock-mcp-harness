# Single Run Supervisor

AgentDock v0.4 introduces a single execution-owner seam for child processes.

## Roles

For a given authoritative state store, production runs one dedicated `agentdock-supervisor` daemon as the **owner**. HTTP, stdio, OAuth, and tunnel-facing runtimes run in `client` mode and delegate Run start/status/output/cancel operations over a Unix-domain socket.

Embedded/test runtimes may still use `auto`: the first runtime in one host process becomes owner and later runtimes become in-process clients.

Explicit modes:

- `auto` — become owner when none exists, otherwise become a client.
- `owner` — require ownership; fail closed if an owner already exists.
- `client` — use the configured Unix-domain socket when no in-process owner exists; fail closed when the daemon is unavailable.

Environment override:

```text
AGENTDOCK_SUPERVISOR_MODE=auto|owner|client
AGENTDOCK_SUPERVISOR_SOCKET=~/.local/state/agentdock/run-supervisor.sock
```

The Supervisor is deliberately separate from Guarded Execution. Guarded Execution decides whether/how a command may launch; the Supervisor owns the child-process lifecycle.

## Safety invariants

- A persisted PID is diagnostic metadata, never authority to signal a process.
- Only a live in-memory child handle owned by the Supervisor may receive signals.
- A durable RUNNING record that claims the current runtime but has no in-memory child handle is reconciled to `INTERRUPTED`; AgentDock does not probe or signal the stored PID.
- A client runtime can cancel an owner Run through the Supervisor seam.
- The socket lives inside the mode-0700 state directory and is mode 0600.
- Existing `run.start / run.get / run.cancel` and legacy `process.*` contracts remain unchanged.

## Deployment topology

```text
agentdock-http.service ----\
                            +--> Unix socket --> agentdock-supervisor.service --> child process groups
agentdock-mcp.service -----/
```

Start `agentdock-supervisor.service` first. Every transport must set `AGENTDOCK_SUPERVISOR_MODE=client`; the daemon alone sets `owner`. If the daemon or socket is unavailable, execution operations fail closed with `SUPERVISOR_UNAVAILABLE`. They never fall back to signalling a persisted PID.
