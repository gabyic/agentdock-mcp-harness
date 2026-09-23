# 01: Reconcile the production source baseline

**What to build:** Produce one development history that contains both the local AgentDock v0.3/v0.4 work and the remote immutable-release hardening, while preserving the current production behavior and establishing an explicit Guarded Execution rollout default of off.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The feature branch contains both sides of the current local-main/origin-main divergence without dropping either change set.
- [x] Release-hardening tests remain green after reconciliation.
- [x] Guarded Execution is documented as disabled by default during implementation.
- [x] Full existing test suite remains green.
