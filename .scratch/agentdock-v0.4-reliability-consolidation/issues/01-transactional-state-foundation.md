# 01: Transactional State Foundation

**What to build:** Add a selectable SQLite durable-state adapter beside legacy JSON on the current main baseline, preserving Execution Reliability v2 while proving cross-process transactional mutation and idempotent legacy import.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] SQLite uses built-in Node SQLite with WAL, foreign keys, busy timeout, explicit schema versioning/migrations, and serialized startup.
- [x] Legacy JSON durable state can be imported idempotently without deleting or mutating the legacy source files.
- [x] Two independent Node processes can transactionally update the same logical record without losing either update.
- [x] JSON remains available only as the compatibility adapter during this expansion ticket; production cutover is explicitly deferred to Ticket 02.
- [x] Existing run.start/run.get/run.cancel bounded-output behavior is unchanged.
- [x] No new npm database dependency is introduced.
- [x] Targeted state tests and the full existing test suite pass.
