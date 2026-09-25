# 06: Single Run Supervisor

**What to build:** Introduce one local execution owner for child processes so all transports observe/control the same Run without relying on stale PID ownership guesses.

**Blocked by:** 02: Authoritative Task State Cutover; 03: Idempotent Mutating Operations

**Status:** done

- [x] Production stdio/HTTP/OAuth/tunnel-facing runtimes are transport adapters. A dedicated long-lived Supervisor daemon is the only child-process owner and transports delegate over a permission-restricted Unix-domain socket.
- [x] Cross-runtime and cross-Linux-process Run cancellation reaches the actual Supervisor-owned process group through authenticated local IPC.
- [x] A persisted PID alone is never sufficient authorization to signal a process.
- [x] The reproduced stale-record/PID-reuse regression cannot kill an unrelated process.
- [x] Owner loss is reported as INTERRUPTED/owner unavailable rather than guessed from arbitrary PID liveness.
- [x] Guarded Execution sandbox policy remains a separate module from Run ownership.
- [x] Existing Run v2 public behavior remains compatible.
