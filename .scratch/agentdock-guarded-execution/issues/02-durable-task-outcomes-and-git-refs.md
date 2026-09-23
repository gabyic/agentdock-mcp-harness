# 02: Make Task completion durable and evidence-bearing

**What to build:** Make a completed coding Task produce a durable outcome that survives worktree cleanup and Git garbage collection, while supporting legitimate NO_CHANGE investigations without fake commits.

**Blocked by:** 01: Reconcile the production source baseline

**Status:** ready-for-agent

- [ ] COMMIT completion anchors the final commit under an AgentDock-owned durable Git ref before the Task becomes COMPLETED.
- [ ] Worktree cleanup preserves the durable ref and a forced reflog expiry/Git GC cannot remove the final commit.
- [ ] NO_CHANGE is a first-class completion outcome and requires a non-empty reason/evidence.
- [ ] An untouched Task cannot claim a COMMIT outcome without commit evidence.
- [ ] Existing cancel/cleanup behavior remains compatible.
