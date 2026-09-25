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

Record the deployed commit, effective config, unit files, state path, and filesystem free space. Use the same absolute, versioned Node 24+ executable pinned by the production units. Do not assume `/usr/bin/node` satisfies the package runtime floor, and do not use a movable symlink for a cutover. Before stopping services, record the effective unit definitions and verify that their `ExecStart` paths and running `/proc/<pid>/exe` targets resolve to the same accepted binary. The current accepted checkout is `/home/ubuntu/AgentDock` and its pinned runtime is `/opt/node-v24.21.0/bin/node`:

```bash
/opt/node-v24.21.0/bin/node --version
sudo systemctl show -p FragmentPath -p DropInPaths -p ExecStart -p EnvironmentFiles \
  agentdock-supervisor.service agentdock-http.service agentdock-mcp.service
sudo readlink /proc/$(systemctl show -p MainPID --value agentdock-supervisor.service)/exe
sudo readlink /proc/$(systemctl show -p MainPID --value agentdock-http.service)/exe
```

Then prevent dual writers by stopping public transports first and the execution owner last:

```bash
sudo systemctl stop agentdock-mcp.service
sudo systemctl stop agentdock-http.service
sudo systemctl stop agentdock-supervisor.service
sudo systemctl is-active agentdock-mcp.service agentdock-http.service agentdock-supervisor.service
```

Do not continue merely because the three main PIDs exited. Confirm the service cgroups are empty and that no same-user process still has `agentdock.db`, its WAL files, or another path below the state directory open. The cutover command performs a second Linux `/proc/<pid>/fd` scan and rejects any live PID recorded in a runtime lease even when that lease heartbeat is stale. The lease check alone is not sufficient because HTTP and MCP client runtimes are also SQLite writers.

Choose a new backup path outside the state directory. The backup command refuses an existing destination, a destination physically nested in state, a live Supervisor lease, or an open state-owner handle. Run it with enough privilege to inspect protected `/proc/<pid>/fd` directories; the scanner targets the state directory owner's UID rather than the invoking UID, so running it as root does not skip the service account. When invoked as root for that scan, the command performs the backup and all SQLite writes with the state directory owner's effective UID/GID so a first migration cannot leave root-owned runtime state:

Run the cutover from that accepted checkout with the same versioned binary:

```bash
sudo /opt/node-v24.21.0/bin/node \
  /home/ubuntu/AgentDock/scripts/state-cutover.mjs \
  --state-dir /home/ubuntu/agentdock-runtime/state \
  --backup-dir /home/ubuntu/agentdock-backups/pre-ticket10-YYYYMMDDTHHMMSSZ \
  --maintenance-confirmed
```

The command copies the complete state tree, including SQLite WAL files and Task worktrees, before opening/importing state. It then checks SQLite integrity and verifies that every supported legacy Task, Process, Audit, Workflow, Plan, and idempotency-operation identity exists in SQLite. Unsupported legacy `.json` filenames fail closed instead of being silently skipped. A first JSON import also requires normalized content equality, and the verified-import marker is written only after all checks pass.

The cutover command does not hash the copied directory. Generate a deterministic binary manifest outside the immutable checkpoint and keep it private. The manifest is a sequence of NUL-delimited fields: a version header, then type, mode, numeric owner, numeric group, path, symbolic-link target, and regular-file SHA-256 for every sorted path. NUL is the only byte that cannot occur in a Linux pathname or symbolic-link target, so spaces, newlines, and other pathname bytes remain unambiguous. Verification regenerates the complete enumeration and compares it byte-for-byte, so added or removed paths, changed symlink targets, tracked mode/owner/group changes, and changed regular-file contents all fail.

Define the generator in the operator shell. The checkpoint must remain quiesced while either creation or verification runs:

```bash
set -Eeuo pipefail
export LC_ALL=C
checkpoint_dir=/home/ubuntu/agentdock-backups/pre-ticket10-YYYYMMDDTHHMMSSZ
checkpoint_manifest=${checkpoint_dir}.sha256-manifest
checkpoint_manifest_sidecar=${checkpoint_manifest}.sha256

generate_checkpoint_manifest() {
  local checkpoint_root="$1"
  local entry entry_type hash_record
  (
    set -Eeuo pipefail
    cd "${checkpoint_root}"
    printf 'AGENTDOCK-CHECKPOINT-MANIFEST-V2\0'
    find . -print0 | sort -z |
    while IFS= read -r -d '' entry; do
      if [[ -L "${entry}" ]]; then
        entry_type=L
      elif [[ -f "${entry}" ]]; then
        entry_type=F
      elif [[ -d "${entry}" ]]; then
        entry_type=D
      else
        entry_type=O
      fi

      printf '%s\0' "${entry_type}"
      stat --printf '%f\0%u\0%g\0' -- "${entry}"
      printf '%s\0' "${entry}"

      if [[ "${entry_type}" == L ]]; then
        readlink --zero -- "${entry}"
      else
        printf '\0'
      fi

      if [[ "${entry_type}" == F ]]; then
        sha256sum --zero -- "${entry}" |
          {
            IFS= read -r -d '' hash_record
            [[ "${hash_record:0:64}" =~ ^[0-9a-f]{64}$ ]]
            printf '%s\0' "${hash_record:0:64}"
          }
      else
        printf '\0'
      fi
    done
  )
}
```

Create each manifest exactly once. This creation path fails closed if either final artifact already exists; it never replaces a prior baseline. The temporary files live beside the final files so the hard-link publications are atomic on one filesystem. Record the printed manifest SHA-256 in the batch record or acceptance record before any GC:

```bash
[[ ! -e "${checkpoint_manifest}" && ! -L "${checkpoint_manifest}" ]]
[[ ! -e "${checkpoint_manifest_sidecar}" && ! -L "${checkpoint_manifest_sidecar}" ]]

manifest_create_tmp=$(mktemp "${checkpoint_manifest}.create.XXXXXX")
sidecar_create_tmp=$(mktemp "${checkpoint_manifest_sidecar}.create.XXXXXX")
cleanup_manifest_create_temps() {
  rm -f -- "${manifest_create_tmp}" "${sidecar_create_tmp}"
}
trap cleanup_manifest_create_temps EXIT

generate_checkpoint_manifest "${checkpoint_dir}" >"${manifest_create_tmp}"
chmod 0600 "${manifest_create_tmp}"
manifest_sha256_line=$(sha256sum -- "${manifest_create_tmp}")
manifest_sha256=${manifest_sha256_line%% *}
[[ "${manifest_sha256}" =~ ^[0-9a-f]{64}$ ]]
printf '%s  %s\n' "${manifest_sha256}" "${checkpoint_manifest}" \
  >"${sidecar_create_tmp}"
chmod 0600 "${sidecar_create_tmp}"

ln -T -- "${manifest_create_tmp}" "${checkpoint_manifest}"
ln -T -- "${sidecar_create_tmp}" "${checkpoint_manifest_sidecar}"
sha256sum -c -- "${checkpoint_manifest_sidecar}"
printf 'Record checkpoint manifest SHA-256: %s\n' "${manifest_sha256}"
cleanup_manifest_create_temps
trap - EXIT
```

For every later verification, use the SHA-256 already recorded outside the checkpoint as the trust anchor. Do not recreate or overwrite the manifest or sidecar. Validate that original manifest first, then regenerate only into a temporary file and compare it with the original byte-for-byte:

```bash
expected_manifest_sha256=REPLACE_WITH_RECORDED_64_HEX_SHA256
[[ "${expected_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]]
[[ -f "${checkpoint_manifest}" && ! -L "${checkpoint_manifest}" ]]
[[ -f "${checkpoint_manifest_sidecar}" && ! -L "${checkpoint_manifest_sidecar}" ]]

actual_manifest_sha256_line=$(sha256sum -- "${checkpoint_manifest}")
actual_manifest_sha256=${actual_manifest_sha256_line%% *}
[[ "${actual_manifest_sha256}" == "${expected_manifest_sha256}" ]]
sha256sum -c -- "${checkpoint_manifest_sidecar}"

manifest_verify_tmp=$(mktemp /tmp/agentdock-checkpoint-verify.XXXXXX)
cleanup_manifest_verify_tmp() {
  rm -f -- "${manifest_verify_tmp}"
}
trap cleanup_manifest_verify_tmp EXIT
generate_checkpoint_manifest "${checkpoint_dir}" >"${manifest_verify_tmp}"
cmp -s -- "${checkpoint_manifest}" "${manifest_verify_tmp}"
cleanup_manifest_verify_tmp
trap - EXIT
```

An existing SQLite database with no verified cutover marker is ambiguous. After independently confirming that it is the currently authoritative production database, acknowledge that one condition explicitly:

```bash
sudo /opt/node-v24.21.0/bin/node \
  /home/ubuntu/AgentDock/scripts/state-cutover.mjs \
  --state-dir /home/ubuntu/agentdock-runtime/state \
  --backup-dir /home/ubuntu/agentdock-backups/pre-ticket10-YYYYMMDDTHHMMSSZ \
  --maintenance-confirmed \
  --existing-sqlite-authoritative
```

Do not use that flag to bypass a failed initial import. Restore the untouched backup, fix the reported cause, and rerun the initial cutover. On an already-authoritative SQLite deployment, content divergence from old JSON is reported and expected; missing legacy identities or failed integrity are still fatal.

Keep the backup private and unchanged for at least seven 24-hour days after the last production GC batch. Validate rollback material by copying the backup to an isolated directory, opening the copied SQLite database read-only with the exact deployed Node/AgentDock version, running `PRAGMA integrity_check`, and comparing the reported identity manifest. Never test a restore by opening the only backup in write mode.

Retain the exact versioned Node installation, code revision, CLI launcher, unit fragments/drop-ins, effective `FragmentPath`/`DropInPaths`/`ExecStart`/`EnvironmentFiles`, enabled state, and production environment files beside the backup manifest. Environment files may contain secrets: copy their recoverable contents only into a private or encrypted snapshot with directory mode `0700` and file mode `0600`, never print them, and record checksums separately. A checksum without the recoverable private content is not a rollback backup. These files are outside `state.dir` and are not copied by the state-cutover command.

## Restart and smoke

Start the owner before its clients:

```bash
sudo systemctl start agentdock-supervisor.service
sudo -u ubuntu /bin/bash -lc '
  set -a
  source /home/ubuntu/agentdock-runtime/agentdock.env
  set +a
  export AGENTDOCK_STATE_DIR=/home/ubuntu/agentdock-runtime/state
  export AGENTDOCK_SUPERVISOR_MODE=client
  exec /opt/node-v24.21.0/bin/node \
    /home/ubuntu/AgentDock/src/cli.js doctor --json
'
sudo systemctl start agentdock-http.service
/opt/node-v24.21.0/bin/node /home/ubuntu/AgentDock/src/cli.js \
  health --url http://127.0.0.1:3100/healthz --json
```

Wait for the Supervisor socket to answer before starting HTTP. On the current production topology, port `3100` is AgentDock Core and port `3400` is the OAuth proxy; the proxy's generic `/healthz` does not validate Core state. The Core health JSON must report `state_backend=sqlite`, `supervisor.ready=true`, and `supervisor.mode=client`. Doctor must report the production state directory, SQLite backend, client Supervisor mode, production socket, and the same live Supervisor instance id as Core health; `overall_status=PASS` alone is insufficient. Keep public MCP/OAuth ingress stopped while performing the first local reconciliation and canary GC. Then start it and verify a Run created through one transport can be observed, read, and cancelled through the other:

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

The single verified pre-cutover backup covers the 38 historical production Tasks because they predate it. The post-cutover canary and two reclaimed smoke Tasks were explicitly disposable acceptance artifacts and contained no production user result. The synthetic canary commit is protected by its canonical/safety refs and recovery proof; the reclaimed smoke Tasks were `NO_CHANGE`. Their post-cutover Task/Run/Audit rows are not promised by that database rollback point. Their Git recovery boundary is the recorded final SHA and retained safety ref. The final-process smoke was not GC'd and remains a clean registered worktree pending a future freshly checkpointed batch.

That exception ends with Ticket 10. For every later production GC batch, first finalize and select the intended Tasks, then stop writers and create a new uniquely named quiesced checkpoint before running the batch's final reconciliation/GC. Use the same state-cutover backup procedure, generate and verify its deterministic checksum manifest, and validate an isolated read-only restore with the exact deployed Node and code. The batch manifest must bind the checkpoint path and manifest SHA-256 to the selected Task ids, expected SHAs, safety refs, `gc_completed_at`, and a per-ref `retain_until`. If storage is insufficient for a verified checkpoint, do not run GC.

If state changes between preview and cleanup, GC returns `RECONCILE_SNAPSHOT_CHANGED`. If one selected Task changes during a batch, its result is `FAILED` while other item results remain explicit and auditable. Reconcile again before retrying.

Verify the automatically created safety ref for one exact reviewed Task at a time:

```bash
git -C /absolute/source/repo show-ref --verify \
  refs/agentdock/gc-safety/task_EXACT_ID
```

Keep every `refs/agentdock/gc-safety/*` ref for at least seven full days after that exact Task's GC. Ticket 10 never deletes safety refs automatically. Canonical `refs/agentdock/tasks/*` refs are outside this safety-ref expiry procedure and must not be deleted by it. After a safety ref's individual window has expired and the corresponding checkpoint restore has been verified, an operator may remove only one reviewed safety ref at a time, supplying its expected old SHA so a changed ref is not deleted accidentally:

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

For a runtime/unit rollback, use the recorded private evidence bundle rather than reconstructing configuration from hashes: stop MCP/OAuth, HTTP, and Supervisor; restore the exact backed-up unit fragments, drop-ins, CLI launcher, private environment files, code revision, and Node runtime paths with their recorded ownership/modes; run `systemctl daemon-reload`; then start Supervisor, HTTP, and MCP/OAuth in that order and repeat the same doctor, health, and cross-transport assertions. Never print the restored secret-bearing environment files.

Do not set `AGENTDOCK_STATE_BACKEND=json` after SQLite has diverged. To recover one GC'd Task during the window, restore the matching database checkpoint in maintenance mode, verify that Task's single explicit safety ref and expected SHA, move only that Task's copied worktree directory to quarantine if it occupies the target path, and recreate the registration with:

```bash
git -C /absolute/source/repo worktree add --detach \
  /home/ubuntu/agentdock-runtime/state/worktrees/task_EXACT_ID \
  refs/agentdock/gc-safety/task_EXACT_ID
```

Verify the recreated worktree is clean and at the manifest SHA before starting any service. Repeat this procedure explicitly per Task; do not use a wildcard, repository-wide prune, or bulk safety-ref deletion as a rollback shortcut.
