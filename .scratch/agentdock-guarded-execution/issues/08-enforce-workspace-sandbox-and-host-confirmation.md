# 08: Enforce the Workspace sandbox and Host confirmation

**What to build:** In enforce mode, run routine Task processes inside the validated OS sandbox and make host/privileged side effects use explicit authorization with MCP-native human confirmation when available.

**Blocked by:** 04: Migrate durable state callers to the transactional seam; 07: Add the Guarded Execution seam in observe mode

**Status:** done

- [x] Workspace tests/builds can write the Task worktree and run normally while outside writes are OS-blocked.
- [x] Sensitive configured paths are hidden and default Workspace network policy is enforced.
- [x] Host absolute file mutation authorizes before any filesystem side effect.
- [x] Human-required modern MCP calls use input_required elicitation and execute only after accepted confirmation.
- [x] A client without elicitation capability cannot cause a human-required action to execute.
- [x] Existing Approval behavior remains an explicit compatibility fallback rather than an automatic bypass.
