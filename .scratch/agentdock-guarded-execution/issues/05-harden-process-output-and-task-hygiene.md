# 05: Bound process state and surface stale Tasks

**What to build:** Keep live process debugging useful while bounding memory/persistence, redacting durable command/output previews, and making abandoned durable Tasks discoverable without auto-deleting them.

**Blocked by:** 04: Migrate durable state callers to the transactional seam

**Status:** ready-for-agent

- [ ] Live process output is byte-bounded with correct output-floor cursor semantics.
- [ ] Durable command/env/stdout/stderr summaries do not retain raw canary credentials.
- [ ] Process status distinguishes live ownership from persisted historical state without another runtime falsely marking an owned process interrupted.
- [ ] Users can list ACTIVE/finalized/stale Task state without filesystem inspection.
- [ ] No stale Task is automatically deleted based only on age.
