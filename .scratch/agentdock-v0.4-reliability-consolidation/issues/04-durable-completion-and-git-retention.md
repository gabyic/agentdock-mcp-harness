# 04: Durable Completion and Git Retention

**What to build:** Make Task completion produce durable COMMIT or NO_CHANGE outcomes whose evidence survives worktree cleanup and Git garbage collection.

**Blocked by:** 02: Authoritative Task State Cutover

**Status:** ready-for-agent

- [ ] COMMIT completion anchors the final commit under an AgentDock-owned durable Git ref before Task completion.
- [ ] Worktree cleanup refuses to proceed when required retention evidence is missing.
- [ ] The retained commit survives worktree cleanup, reflog expiry, and aggressive Git GC.
- [ ] NO_CHANGE is a first-class outcome with non-empty reason/evidence and no fake commit.
- [ ] Existing cancel behavior remains compatible.
