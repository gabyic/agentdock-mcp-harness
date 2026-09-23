# 04: Migrate durable state callers to the transactional seam

**What to build:** Move Task, Approval, Audit, Workflow, and persisted Process metadata mutations through the transactional StateStore so concurrent runtimes do not silently overwrite durable state.

**Blocked by:** 03: Expand a transactional SQLite StateStore beside legacy JSON

**Status:** ready-for-agent

- [ ] Task/Approval/Audit/Workflow mutations are transactionally serialized through the StateStore interface.
- [ ] Workflow concurrent-update regression no longer loses either update/history entry.
- [ ] Persisted process metadata uses the same canonical state backend while live child ownership remains explicit.
- [ ] Reconnect/restart tests continue to pass.
- [ ] Legacy JSON is import input rather than a second ongoing source of truth when SQLite mode is enabled.
