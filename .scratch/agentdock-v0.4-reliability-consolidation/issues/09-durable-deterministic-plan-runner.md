# 09: Durable Deterministic Plan Runner

**What to build:** Expand the Minimal Durable Verification Runner into the full deterministic development Plan Runner, including Supervisor-backed restart recovery, explicit reasoning/human barriers, Completion Contract evidence, and safe commit/finish steps.

**Blocked by:** 03A: Minimal Durable Verification Runner; 06: Single Run Supervisor; 07: Truthful Task Activity and Blockers; 08: Completion Evidence Contract

**Status:** done

- [x] A durable Plan contains stable step ids, idempotency keys, dependencies, success criteria, evidence, and explicit blocker semantics.
- [x] Passing deterministic steps continue without requiring the initiating ChatGPT turn to remain connected.
- [x] A failed/ambiguous step stops in AWAITING_ASSISTANT and never auto-invents a repair.
- [x] Approval/human-confirmation boundaries stop in the appropriate waiting state.
- [x] Reconnect/resume exposes current step, last successful step, blocker, and evidence.
- [x] No server-side LLM or hidden reasoning loop is introduced.
