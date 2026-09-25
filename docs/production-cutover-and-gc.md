# Production state cutover and Task GC

This procedure is the production boundary for moving durable AgentDock state to SQLite and reclaiming finalized Task worktrees. It is deliberately fail-closed: ACTIVE Tasks, orphan directories, dirty worktrees, unregistered paths, open Runs/Plans/approvals, contradictory completion records, and unretained commits are reported but never automatically deleted.

## Safety policy

- SQLite is the only supported multi-process production authority.
- Legacy JSON is import material, not a second writer. After SQLite has changed, JSON is stale history and cannot be used as a current rollback source.
- `task.reconcile` is observational. It gives stale ACTIVE Tasks the `NEEDS_ATTENTION` disposition and never changes Task state.
- `task.gc` accepts only explicit Task ids from an unchanged reconciliation token.
- A finalized Task must be older than `stale_after_seconds` (one hour by default).
- A cancelled Task is eligible only when its registered worktree is clean and still at `base_head`.
- A completed COMMIT is eligible only when its worktree is clean, HEAD equals `final_commit_sha`, and the canonical `refs/agentdock/tasks/<task_id>` ref still points to that commit.
- A completed NO_CHANGE is eligible only when its final SHA equals `base_head` and it has a non-empty reason.
- Automated GC uses non-force `git worktree remove` and does not run repository-wide worktree pruning.
- Orphan worktrees are inventory only. This procedure never removes them.

## Maintenance and backup

Record the deployed commit, effective config, unit files, state path, and filesystem free space. Then prevent dual writers by stopping public transports first and the execution owner last:

```bash
sudo systemctl stop agentdock-mcp.service
sudo systemctl stop agentdock-http.service
sudo systemctl stop agentdock-supervisor.service
sudo systemctl is-active agentdock-mcp.service agentdock-http.service agentdock-supervisor.service
```

Do not continue merely because the three main PIDs exited. Confirm the service cgroups are empty and that no same-user process still has `agentdock.db`, its WAL files, or another path below the state directory open. The cutover command performs a second Linux `/proc/<pid>/fd` scan and rejects any live PID recorded in a runtime lease even when that lease heartbeat is stale. The lease check alone is not sufficient because HTTP and MCP client runtimes are also SQLite writers.

Choose a new backup path outside the state directory. The backup command refuses an existing destination, a destination physically nested in state, a live Supervisor lease, or an open state-owner handle. Run it with enough privilege to inspect protected `/proc/<pid>/fd` directories; the scanner targets the state directory owner's UID rather than the invoking UID, so running it as root does not skip the service account:

```bash
sudo /usr/bin/node scripts/state-cutover.mjs \
  --state-dir /home/ubuntu/agentdock-runtime/state \
  --backup-dir /home/ubuntu/agentdock-backups/pre-ticket10-YYYYMMDDTHHMMSSZ \
  --maintenance-confirmed
```

The command copies the complete state tree, including SQLite WAL files and Task worktrees, before opening/importing state. It then checks SQLite integrity and verifies that every supported legacy Task, Process, Audit, Workflow, Plan, and idempotency-operation identity exists in SQLite. Unsupported legacy `.json` filenames fail closed instead of being silently skipped. A first JSON import also requires normalized content equality, and the verified-import marker is written only after all checks pass.

An existing SQLite database with no verified cutover marker is ambiguous. After independently confirming that it is the currently authoritative production database, acknowledge that one condition explicitly:

```bash
sudo /usr/bin/node scripts/state-cutover.mjs \
  --state-dir /home/ubuntu/agentdock-runtime/state \
  --backup-dir /home/ubuntu/agentdock-backups/pre-ticket10-YYYYMMDDTHHMMSSZ \
  --maintenance-confirmed \
  --existing-sqlite-authoritative
```

Do not use that flag to bypass a failed initial import. Restore the untouched backup, fix the reported cause, and rerun the initial cutover. On an already-authoritative SQLite deployment, content divergence from old JSON is reported and expected; missing legacy identities or failed integrity are still fatal.

Keep the backup private and unchanged for at least seven 24-hour days after the last production GC batch. Validate rollback material by copying the backup to an isolated directory, opening the copied SQLite database read-only with the exact deployed Node/AgentDock version, running `PRAGMA integrity_check`, and comparing the reported identity manifest. Never test a restore by opening the only backup in write mode. Retain the exact code, config, and unit versions beside the backup manifest; they are outside `state.dir` and are not copied by the command.

## Restart and smoke

Start the owner before its clients:

```bash
sudo systemctl start agentdock-supervisor.service
sudo systemctl start agentdock-http.service
agentdock doctor --json
agentdock health --url http://127.0.0.1:3100/healthz --json
```

Wait for the Supervisor socket to answer before starting HTTP. On the current production topology, port `3100` is AgentDock Core and port `3400` is the OAuth proxy; the proxy's generic `/healthz` does not validate Core state. The Core health JSON must report `state_backend=sqlite`, `supervisor.ready=true`, and `supervisor.mode=client`. Keep public MCP/OAuth ingress stopped while performing the first local reconciliation and canary GC. Then start it and verify a Run created through one transport can be observed, read, and cancelled through the other:

```bash
sudo systemctl start agentdock-mcp.service
```

The cross-transport smoke must cover `run.start`, `run.get` output continuity, and `run.cancel`. Persisted PID metadata is diagnostic only and never authorizes signalling.

## Reconcile and GC

1. Call `task.reconcile` with the intended `stale_after_seconds`.
2. Save its JSON report and inspect every candidate and blocked reason.
3. Confirm all stale ACTIVE Tasks appear only under `needs_attention`.
4. For each selected Task, record `source_repo` and expected HEAD in the batch manifest. Immediately before non-force worktree removal, `task.gc` atomically creates and verifies the fixed `refs/agentdock/gc-safety/<task_id>` ref at that expected HEAD. It accepts an existing ref only when it already points to the same commit; a different value blocks cleanup instead of being overwritten. Record the returned `task.gc_safety_ref` in the manifest. A completed COMMIT must retain its canonical `refs/agentdock/tasks/<task_id>` ref as well.
5. Start with one already-eligible historical candidate, or wait at least 60 seconds after finalizing a dedicated canary and use `stale_after_seconds=60` for both reconcile and GC.
6. Call `task.gc` with the exact `reconcile_token` and only that canary id.
7. Verify the worktree is gone, Task metadata is marked cleaned, and both its canonical retention ref (when required) and its GC safety ref still resolve. Run aggressive Git GC only in a dedicated disposable canary repository, never as a blanket production smoke.
8. Re-run `task.reconcile`; use the new token for each small explicit batch.

If state changes between preview and cleanup, GC returns `RECONCILE_SNAPSHOT_CHANGED`. If one selected Task changes during a batch, its result is `FAILED` while other item results remain explicit and auditable. Reconcile again before retrying.

Verify the automatically created safety ref for one exact reviewed Task at a time:

```bash
git -C /absolute/source/repo show-ref --verify \
  refs/agentdock/gc-safety/task_EXACT_ID
```

Keep every `refs/agentdock/gc-safety/*` ref for at least the same seven-day rollback window. Ticket 10 never deletes safety refs automatically. After the window has expired and the corresponding backup restore has been verified, an operator may remove only one reviewed Task ref at a time, supplying its expected old SHA so a changed ref is not deleted accidentally:

```bash
git -C /absolute/source/repo update-ref -d \
  refs/agentdock/gc-safety/task_EXACT_ID \
  EXPECTED_40_HEX_SHA
```

## Rollback window

Retain the complete pre-change backup, batch manifests, GC safety refs, and exact deployed code/config for a minimum seven-day rollback window. The database rollback boundary and the Git worktree recovery boundary are separate:

- Before authoritative SQLite has diverged, the pre-cutover backup may return an initial JSON migration to its starting point.
- After SQLite mutations begin, rollback requires a complete SQLite checkpoint from the intended recovery point. Old legacy JSON is no longer current state.
- A state-directory copy contains worktree files but not the linked-worktree administrative records removed from each external source repository by `git worktree remove`. It cannot by itself restore a valid registered worktree.

During a database rollback:

1. stop MCP/OAuth, HTTP, and Supervisor;
2. move the current state directory aside without deleting it;
3. restore the complete SQLite backup to the original state path with its original ownership and permissions;
4. restore the matching code/config/unit version;
5. start Supervisor first, then HTTP and MCP/OAuth;
6. repeat integrity, health, and cross-transport smoke checks.

Do not set `AGENTDOCK_STATE_BACKEND=json` after SQLite has diverged. To recover one GC'd Task during the window, restore the matching database checkpoint in maintenance mode, verify that Task's single explicit safety ref and expected SHA, move only that Task's copied worktree directory to quarantine if it occupies the target path, and recreate the registration with:

```bash
git -C /absolute/source/repo worktree add --detach \
  /home/ubuntu/agentdock-runtime/state/worktrees/task_EXACT_ID \
  refs/agentdock/gc-safety/task_EXACT_ID
```

Verify the recreated worktree is clean and at the manifest SHA before starting any service. Repeat this procedure explicitly per Task; do not use a wildcard, repository-wide prune, or bulk safety-ref deletion as a rollback shortcut.
