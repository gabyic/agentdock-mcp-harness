# 05: Secure Durable Output and Task Hygiene Visibility

**What to build:** Preserve useful live Run output while making durable previews bounded/redacted and exposing stale Task state without destructive age-based cleanup.

**Blocked by:** 02: Authoritative Task State Cutover

**Status:** ready-for-agent

- [ ] Durable command/env/stdout/stderr previews do not retain secret canaries.
- [ ] Existing run.get page-size, cursor, truncation, and long-poll guarantees remain unchanged.
- [ ] A read-only task listing exposes lifecycle, stale age, worktree presence/size, active Runs, and pending blockers.
- [ ] ACTIVE stale Tasks are discoverable but never auto-deleted solely due to age.
- [ ] Current state-directory growth can be inspected without filesystem spelunking.
