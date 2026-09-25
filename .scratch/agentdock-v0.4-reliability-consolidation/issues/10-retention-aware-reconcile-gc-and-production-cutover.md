# 10: Retention-aware Reconcile, GC, and Production Cutover

**What to build:** Safely migrate production to the consolidated reliability architecture and reclaim eligible stale state/worktrees without deleting unreconciled active work or unretained results.

**Blocked by:** 01–09

**Status:** ready-for-agent

- [ ] Production JSON state is imported and cross-checked before SQLite cutover.
- [ ] A defined maintenance/cutover procedure prevents dual writers.
- [ ] Supervisor and transports restart against the same authoritative store and pass end-to-end smoke tests.
- [ ] Finalized Tasks are cleaned only when retention guarantees are satisfied.
- [ ] Cancelled clean Tasks follow an explicit safe cleanup policy.
- [ ] ACTIVE stale Tasks become NEEDS_ATTENTION and are never auto-deleted solely due to age.
- [ ] Existing accumulated Tasks/worktrees are reconciled and eligible disk usage is reclaimed.
- [ ] A rollback window and backup/export procedure are documented and tested.
