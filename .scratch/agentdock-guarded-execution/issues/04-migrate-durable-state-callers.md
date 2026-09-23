# 04: Migrate durable state callers to the transactional seam

**What to build:** Move Task, Approval, Audit, Workflow, and persisted Process metadata mutations through the transactional StateStore so concurrent runtimes do not silently overwrite durable state.

**Blocked by:** 03: Expand a transactional SQLite StateStore beside legacy JSON

**Status:** done

- [x] Task/Approval/Audit/Workflow mutations are transactionally serialized through the StateStore interface.
- [x] Workflow concurrent-update regression no longer loses either update/history entry.
- [x] Persisted process metadata uses the same canonical state backend while live child ownership remains explicit.
- [x] Reconnect/restart tests continue to pass.
- [x] Legacy JSON is import input rather than a second ongoing source of truth when SQLite mode is enabled.
