# 09: Durable Deterministic Plan Runner

**What to build:** Allow already-decided deterministic development/verification steps to continue across ChatGPT response-stream interruptions while stopping cleanly whenever new reasoning or human input is required.

**Blocked by:** 03: Idempotent Mutating Operations; 06: Single Run Supervisor; 07: Truthful Task Activity and Blockers; 08: Completion Evidence Contract

**Status:** ready-for-agent

- [ ] A durable Plan contains stable step ids, idempotency keys, dependencies, success criteria, evidence, and explicit blocker semantics.
- [ ] Passing deterministic steps continue without requiring the initiating ChatGPT turn to remain connected.
- [ ] A failed/ambiguous step stops in AWAITING_ASSISTANT and never auto-invents a repair.
- [ ] Approval/human-confirmation boundaries stop in the appropriate waiting state.
- [ ] Reconnect/resume exposes current step, last successful step, blocker, and evidence.
- [ ] No server-side LLM or hidden reasoning loop is introduced.
