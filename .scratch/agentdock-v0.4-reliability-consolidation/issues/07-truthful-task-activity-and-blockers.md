# 07: Truthful Task Activity and Blockers

**What to build:** Make Task status explain what is actually happening without expanding the durable lifecycle state machine or mutating progress merely by reading it.

**Blocked by:** 02: Authoritative Task State Cutover; 05: Secure Durable Output and Task Hygiene Visibility; 06: Single Run Supervisor

**Status:** done

- [x] Lifecycle remains ACTIVE/COMPLETED/CANCELLED while derived activity state distinguishes EXECUTING, AWAITING_ASSISTANT, AWAITING_APPROVAL, AWAITING_USER, VERIFYING, READY_TO_COMMIT, READY_TO_FINISH, INTERRUPTED, and TERMINAL.
- [x] Pending approval outranks READY_TO_FINISH in task.resume.
- [x] Read-only status/resume calls do not create ordinary durable business/audit progress.
- [x] Last meaningful progress excludes observational reads.
- [x] Current blocker and recommended next action are consistent with authoritative state.
