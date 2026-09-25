# 05: Secure Durable Output and Task Hygiene Visibility

**What to build:** Preserve useful live Run output while making durable previews bounded/redacted and exposing stale Task state without destructive age-based cleanup.

**Blocked by:** 02: Authoritative Task State Cutover

**Status:** done

- [x] Durable command/env/stdout/stderr previews do not retain secret canaries.
- [x] Existing run.get page-size, cursor, truncation, and long-poll guarantees remain unchanged.
- [x] A read-only task listing exposes lifecycle, stale age, worktree presence/size, active Runs, and pending blockers.
- [x] ACTIVE stale Tasks are discoverable but never auto-deleted solely due to age.
- [x] Current state-directory growth can be inspected without filesystem spelunking.
