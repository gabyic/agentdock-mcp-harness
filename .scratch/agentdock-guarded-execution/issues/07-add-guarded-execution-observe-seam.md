# 07: Add the Guarded Execution seam in observe mode

**What to build:** Introduce one deep Execution module with Workspace and Host adapters, sandbox-readiness diagnostics, and off/observe/enforce modes while leaving production behavior unchanged in off/observe.

**Blocked by:** 01: Reconcile the production source baseline

**Status:** ready-for-agent

- [ ] Existing process callers use one execution interface instead of embedding safety classification themselves.
- [ ] Relative Task worktree execution classifies as Workspace; intentional host execution classifies as Host.
- [ ] Off preserves current behavior.
- [ ] Observe records what enforce would sandbox/confirm/deny without changing execution.
- [ ] Enforce refuses to start a Workspace sandbox when the configured sandbox runtime is missing or below the supported version.
- [ ] Doctor reports guarded-execution mode and sandbox readiness.
