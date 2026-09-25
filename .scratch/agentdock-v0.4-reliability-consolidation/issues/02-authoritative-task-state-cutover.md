# 02: Authoritative Task State Cutover

**What to build:** Move production Task/Approval/Audit/Workflow/Run metadata mutations onto the transactional seam and make SQLite the authoritative production state source so stale runtimes cannot lose updates or resurrect terminal Tasks.

**Blocked by:** 01: Transactional State Foundation

**Status:** done

- [x] Mutable Task state is never authoritative from a runtime-local stale object cache.
- [x] Two independent runtimes can append different process ids to one Task without lost updates.
- [x] A COMPLETED or CANCELLED Task cannot transition back to ACTIVE.
- [x] A stale runtime cannot start a new Run on a terminal Task.
- [x] Approval, Audit, Workflow, and persisted Run metadata mutations use the same transactional state seam.
- [x] Production defaults to SQLite authoritative state while legacy JSON is treated as import/rollback material, not a second writer.
- [x] Migration and rollback-window checks are documented and tested.
