# 09: Integrate Guarded Execution and freeze the rollout gate

**What to build:** Integrate every completed slice, run the full black-box/release suite and two-axis code review, document migration/rollout, and keep production enforcement disabled until prerequisites are separately approved.

**Blocked by:** 02: Make Task completion durable and evidence-bearing; 05: Bound process state and surface stale Tasks; 06: Gate Guided Workflow completion on durable evidence; 08: Enforce the Workspace sandbox and Host confirmation

**Status:** ready-for-agent

- [ ] All existing and Guarded Execution regression tests pass.
- [ ] release:verify, release:build, and release:smoke pass.
- [ ] Standards and Spec review have no unresolved blocking findings.
- [ ] Migration/rollback and operator diagnostics are documented.
- [ ] Production config remains off/observe; enforce is not enabled automatically.
- [ ] The final branch is ready for an explicit deployment decision rather than deploying itself.
