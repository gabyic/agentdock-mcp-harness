# 05: Bound process state and surface stale Tasks

**What to build:** Keep live process debugging useful while bounding memory/persistence, redacting durable command/output previews, and making abandoned durable Tasks discoverable without auto-deleting them.

**Blocked by:** 04: Migrate durable state callers to the transactional seam

**Status:** done

- [x] Live process output is byte-bounded with correct output-floor cursor semantics.
- [x] Durable command/env/stdout/stderr summaries do not retain raw canary credentials.
- [x] Process status distinguishes live ownership from persisted historical state without another runtime falsely marking an owned process interrupted.
- [x] Users can list ACTIVE/finalized/stale Task state without filesystem inspection.
- [x] No stale Task is automatically deleted based only on age.
