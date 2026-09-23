# 02: Make Task completion durable and evidence-bearing

**What to build:** Make a completed coding Task produce a durable outcome that survives worktree cleanup and Git garbage collection, while supporting legitimate NO_CHANGE investigations without fake commits.

**Blocked by:** 01: Reconcile the production source baseline

**Status:** done

- [x] COMMIT completion anchors the final commit under an AgentDock-owned durable Git ref before the Task becomes COMPLETED.
- [x] Worktree cleanup preserves the durable ref and a forced reflog expiry/Git GC cannot remove the final commit.
- [x] NO_CHANGE is a first-class completion outcome and requires a non-empty reason/evidence.
- [x] An untouched Task cannot claim a COMMIT outcome without commit evidence.
- [x] Existing cancel/cleanup behavior remains compatible.
