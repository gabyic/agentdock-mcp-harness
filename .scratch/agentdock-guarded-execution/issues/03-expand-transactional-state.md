# 03: Expand a transactional SQLite StateStore beside legacy JSON

**What to build:** Add a transactional durable-state adapter using built-in node:sqlite, with schema versioning and idempotent legacy import, while keeping the current JSON path available during the expansion phase.

**Blocked by:** 01: Reconcile the production source baseline

**Status:** ready-for-agent

- [ ] SQLite uses WAL, foreign keys, busy timeout, and explicit schema migrations.
- [ ] Existing JSON state can be imported idempotently without deleting legacy files.
- [ ] Two independent Node processes can update the same logical record without lost updates.
- [ ] The state backend is selectable and the production default remains unchanged during expansion.
- [ ] No new npm database dependency is added.
