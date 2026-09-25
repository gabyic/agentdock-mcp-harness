# 10: Retention-aware Reconcile, GC, and Production Cutover

**What to build:** Safely migrate production to the consolidated reliability architecture and reclaim eligible stale state/worktrees without deleting unreconciled active work or unretained results.

**Blocked by:** 01–09

**Status:** done

- [x] Production JSON state is imported and cross-checked before SQLite cutover.
- [x] A defined maintenance/cutover procedure prevents dual writers.
- [x] Supervisor and transports restart against the same authoritative store and pass end-to-end smoke tests.
- [x] Finalized Tasks are cleaned only when retention guarantees are satisfied.
- [x] Cancelled clean Tasks follow an explicit safe cleanup policy.
- [x] ACTIVE stale Tasks become NEEDS_ATTENTION and are never auto-deleted solely due to age.
- [x] Existing accumulated Tasks/worktrees are reconciled and eligible disk usage is reclaimed.
- [x] A rollback window and backup/export procedure are documented and tested.
