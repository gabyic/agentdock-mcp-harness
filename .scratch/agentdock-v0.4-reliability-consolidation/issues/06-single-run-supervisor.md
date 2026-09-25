# 06: Single Run Supervisor

**What to build:** Introduce one local execution owner for child processes so all transports observe/control the same Run without relying on stale PID ownership guesses.

**Blocked by:** 02: Authoritative Task State Cutover; 03: Idempotent Mutating Operations

**Status:** ready-for-agent

- [ ] stdio, HTTP, OAuth/tunnel-facing runtimes are transport adapters rather than child-process owners.
- [ ] Cross-transport Run cancellation reaches the actual Supervisor-owned process group.
- [ ] A persisted PID alone is never sufficient authorization to signal a process.
- [ ] The reproduced stale-record/PID-reuse regression cannot kill an unrelated process.
- [ ] Owner loss is reported as INTERRUPTED/owner unavailable rather than guessed from arbitrary PID liveness.
- [ ] Guarded Execution sandbox policy remains a separate module from Run ownership.
- [ ] Existing Run v2 public behavior remains compatible.
