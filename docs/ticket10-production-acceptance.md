# Ticket 10 production acceptance

Date: 2026-09-25

This record closes AgentDock v0.4 Ticket 10: production SQLite cutover, retention-aware reconciliation and worktree GC, and cross-transport Single Run Supervisor acceptance. All timestamps are UTC unless stated otherwise.

## Release identity and verification

- Implementation deployed for the acceptance run: `424836fb94b06e5f89d7d8b1372fe334cb9fabec` on `main`.
- Production checkout before this acceptance-record-only follow-up was clean and matched `origin/main`.
- Accepted production runtime: Node.js `v24.21.0` at `/opt/node-v24.21.0/bin/node` on Ubuntu 24.04.
- The official `node-v24.21.0-linux-x64.tar.xz` archive passed its published SHA-256 check (`fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`).
- Clean Linux/Node 24 validation: 109/109 tests passed.
- Complete `release:gate`: passed release metadata, clean install, all 109 tests, v0.1 black-box acceptance, zero npm audit vulnerabilities, systemd contract, reproducible build, and release smoke.
- Verified implementation artifact `dist/agentdock-mcp-harness-v0.4.0-dev.1.tar.gz` SHA-256: `70a9342307bbbc8536e0114e97784c649896360c545d54b422afb428da764a27`.
- Final code review on the deployed implementation: PASS with no release blocker.
- Persisted PID metadata remains diagnostic only. Signal authority comes from the live Supervisor owner; the historical PID-reuse regression test passed.

Final review found that the original system units explicitly used `/usr/bin/node` (`v22.22.3`), below the package's Node 24 production floor. Ticket 10 remained open while Node 24.21.0 was installed side by side; `/usr/bin/node` was not overwritten. Before restart, an observational preflight found one live Run, so the deployment waited for it to finish naturally. The original units were preserved at `/home/ubuntu/agentdock-backups/pre-node24-20260925T123812Z`, then all three AgentDock units were pinned to the versioned Node 24 binary and restarted in Supervisor, HTTP, MCP/OAuth order.

Final unit copies, the CLI launcher, non-secret effective-unit metadata, deployed revision, Node archive identity, and the rollback deadline are stored privately at `/home/ubuntu/agentdock-backups/ticket10-evidence-20260925T150955Z`. Recoverable copies of both production environment files are present there as `private-agentdock.env` and `private-auth.env`, with directory mode `0700` and file mode `0600`; their contents were never printed into logs or committed to Git. The bundle also contains `unit-effective.txt`, `unit-enabled.txt`, and checksum manifests for the final units, launcher, and private config copies. Its `evidence-sha256.txt` manifest has SHA-256 `656bf4dc081aef9c3f47fad756850e3defca6dff2ea83de358ddcb28654e50a3`.

The original unit files, drop-in, and CLI launcher are recoverable from `/home/ubuntu/agentdock-backups/pre-node24-20260925T123812Z`; `pre-node24-sha256.txt` has SHA-256 `b2582e6bf0d2e8414ca6abcb74086532db0bbde53f94172a615819cd894b0669`. The durable per-Task GC audit was exported to `gc-batch-manifest.json`: 41 cleaned, zero failed, 85,379,780 estimated reclaimed bytes. That manifest has SHA-256 `61093d800b0fc6aace1e9a95fc85c1e0b1d276027dbaf6eca436107cfad7b918`. Reconciliation tokens are redacted by the normal audit policy; item identities, policies, timestamps, safety refs, and byte estimates remain recorded.

## Maintenance cutover

The production transports and Supervisor were stopped for the maintenance boundary. The cutover command performed a privileged, state-owner-aware `/proc` handle scan before touching the store. Backup and SQLite work ran as the state directory owner (`uid=1000`, `gid=1001`), not as root.

- State directory: `/home/ubuntu/agentdock-runtime/state`
- Pre-cutover live state bytes: 693,524,773
- Pre-cutover worktree bytes: 644,529,583
- Pre-cutover filesystem available bytes: 14,256,902,144 (83% used)
- Rollback backup: `/home/ubuntu/agentdock-backups/pre-ticket10-20260925T110552Z`
- Backup bytes: 689,348,279
- External deterministic file manifest: `/home/ubuntu/agentdock-backups/pre-ticket10-20260925T110552Z.sha256-manifest`
- Manifest SHA-256: `9330b572eb4c2cd905858aa7344d9cd1ff70aadb073a573a09cef9d44e1a616a` (V2 fixed-field NUL encoding; two independent complete enumerations matched byte-for-byte; trust-anchor and external `sha256sum -c` verification passed)

The V2 generator was also fault-injected on the production host: simulated directory-enumeration exit 7 and regular-file hashing exit 8 both propagated as failures, so a partial manifest cannot be published as successful. The prior ambiguous V1 manifest and sidecar were retained only as superseded audit artifacts with suffix `.superseded-v1-20260925T160615Z`; they are not rollback trust anchors.

- Cutover mode: `EXISTING_SQLITE_BACKUP`
- SQLite schema: version 2
- SQLite integrity: `ok`
- Existing SQLite explicitly confirmed authoritative: yes
- Previous verified-cutover marker: absent, as expected for this first Ticket 10 cutover
- Verified-cutover marker: written only after successful checks

The full backup was created before any cutover write. Database and runtime-lease ownership remained `1000:1001`; the database is mode `0600` and state directories are mode `0700`.

The pre-cutover live-state measurement was taken while services were still running, whereas the backup size was measured from the quiesced maintenance copy after writers stopped. WAL/checkpoint state, the Supervisor socket, and runtime leases are therefore not expected to make those two byte counts identical. Backup completeness was accepted from the identity manifest and isolated read-only restore, not from raw equality with a live-directory size.

The original cutover command used the then-installed `/usr/bin/node` (`v22.22.3`). After the runtime issue was found, the migration was not replayed and the untouched rollback backup was not modified. Instead, the final Node 24 runtime opened the authoritative database read-only and independently returned `integrity_check=ok`, schema version 2, and `cutover_marker_verified=true`; the Node 24 production doctor also passed the SQLite integrity check.

### Identity cross-check

The cutover checked every supported legacy identity against the authoritative SQLite database:

| Record class | Legacy JSON | SQLite | Missing | Divergent |
| --- | ---: | ---: | ---: | ---: |
| Task | 153 | 203 | 0 | 2 |
| Process | 2,260 | 2,936 | 0 | 0 |
| Audit | 153 | 203 | 0 | 3 |
| Workflow | 0 | 0 | 0 | 0 |
| Plan | 0 | 116 | 0 | 0 |
| Idempotency operation | 0 | 300 | 0 | 0 |

Overall there were 2,566 legacy documents, 3,758 SQLite documents, no missing legacy identity, and five expected content divergences where the already-authoritative SQLite records were newer than legacy JSON. The 50 SQLite-only Tasks, 676 SQLite-only Processes, 50 SQLite-only Audits, 116 Plans, and 300 operations were retained.

### Isolated restore proof

The backup was copied to an isolated temporary directory and the copied database was opened read-only with the deployed code. This restore proof was repeated after the runtime correction using exactly `/opt/node-v24.21.0/bin/node` and implementation commit `424836f`. `PRAGMA integrity_check` returned `ok`, `user_version` was 2, and the restored counts were Audit 203, Operation 300, Plan 116, Process 2,936, and Task 203. The pre-cutover copy correctly had no verified-cutover marker. The temporary restore copy was then removed; the original backup was never opened in write mode and remains unchanged.

## Reconciliation and GC

The first one-hour reconciliation preview reported:

- 38 eligible finalized candidates
- 85,367,097 estimated reclaimable bytes
- 28 blocked Tasks: 23 `COMMIT_RETENTION_NONCANONICAL`, five `OPEN_PLANS`
- 34 stale ACTIVE Tasks, all reported only as `NEEDS_ATTENTION`
- zero orphan worktrees

No ACTIVE Task, blocked Task, or orphan directory was deleted.

### Canary

A dedicated disposable repository was used for the first destructive proof. Task `task_8fc20916-5923-494d-87bb-55199559a844` produced commit `a031ed48941702bf2dd04400fc707db55785658e`. Before 60 seconds it was blocked by `RETENTION_WINDOW_OPEN`; after the window it became eligible. Exact-token GC cleaned only that Task, estimated 4,253 reclaimed bytes, created `refs/agentdock/gc-safety/task_8fc20916-5923-494d-87bb-55199559a844`, and left both the canonical Task ref and safety ref at the expected commit. An aggressive Git GC was run only in the disposable canary repository. A recovery worktree was successfully recreated from the safety ref, verified clean, and removed non-forcibly.

### Historical batches

After a single historical no-change canary, the remaining reviewed candidates were cleaned in explicit batches of 10, 10, 10, and 7. Each batch used a fresh reconciliation token. All 38 historical candidates were cleaned, none failed, every cleanup recorded an audit entry, and every cleanup created or verified its fixed safety ref.

| Batch | Cleaned | Estimated reclaimed bytes |
| --- | ---: | ---: |
| First historical Task | 1 | 2,301,170 |
| Batch 1 | 10 | 19,892,749 |
| Batch 2 | 10 | 23,928,099 |
| Batch 3 | 10 | 21,520,466 |
| Batch 4 | 7 | 17,724,613 |
| Historical total | 38 | 85,367,097 |

The controlled post-batch checkpoint reported zero remaining candidates, 28 blocked Tasks, 34 `NEEDS_ATTENTION` Tasks, and zero orphans. At that checkpoint worktrees had fallen from 644,529,583 to 564,610,166 bytes, an actual live-worktree reduction of 79,919,417 bytes. Total live state fell by 83,104,489 bytes, from 693,524,773 to 610,420,284 bytes.

The rollback backup deliberately consumes 689,348,279 bytes, so filesystem free space is not used as the measure of logical GC success. The immediate post-batch filesystem snapshot had 13,401,227,264 available bytes (84% used). Later snapshots also include unrelated concurrent AgentDock activity.

## Cross-transport Supervisor smoke

An initial functional smoke under the old unit runtime passed and was safely reclaimed, but it was not accepted as the final production-runtime proof. It used Task `task_e44470e4-9c9d-44c4-893d-bf32d1d8cec5` and Run `proc_186c4290-a3d3-4fb1-a5b2-6fe20d22a4af`; exact-token GC reclaimed an estimated 4,215 bytes and retained its safety ref.

A first Node 24 smoke used Task `task_40c11ec1-fa70-49c6-bc78-d56b824cd93a` and Run `proc_1e987705-3f6f-4063-9f0f-36d4b5400851`. It passed the full cross-transport sequence and was then exact-token GC'd for an estimated 4,215 bytes, with its safety ref retained. Final review subsequently found and corrected the still-Node-22 CLI launcher used by HTTP `ExecStartPost`, then restarted HTTP, so that earlier Run is supporting evidence rather than the final-process proof.

The accepted smoke was repeated after that last launcher correction and HTTP restart, while the service PIDs shown below were current. It used local Core Streamable HTTP on port 3100 to create and start a Run, then the installed ChatGPT AgentDock connector with an authenticated OAuth session at `https://agentdock.43.135.129.110.sslip.io/mcp` to observe output and cancel it. That request was served by the independently running `agentdock-mcp.service` OAuth proxy on port 3400.

- Task: `task_56b1d17d-17bf-4c58-a798-e6c096c46910`
- Base/final SHA: `927cdeb33dc0ef9cd7e89bed1200c3eac8122251`
- Run: `proc_e4bdbcca-8e1f-41f3-b793-91027c0ea388`
- Core `run.start`: `RUNNING`, non-replayed idempotent start
- OAuth/MCP `run.get`: `RUNNING`, cursor 0 to 5, five ordered `ticket10-final-http-cross-transport-*` stdout lines, no truncation
- OAuth/MCP `run.cancel`: `cancel_requested=true`, transitional state `CANCELLING`
- Core `run.get`: terminal state strictly `CANCELLED`, `SIGTERM`, no extra output and no truncation
- Worktree diff: empty
- Task completion: `COMPLETED`, `NO_CHANGE`, final SHA equals base SHA

The final-process smoke Task remains as a clean, registered, completed `NO_CHANGE` worktree. It was deliberately not GC'd: a later production GC now requires a fresh verified checkpoint under the strengthened runbook. It therefore does not change the 41-entry GC manifest, last-GC timestamp, or safety-ref retention deadline. The worktree is deferred to a future explicitly checkpointed batch, and no unrelated candidate was touched.

The earlier canary and smoke Tasks that were GC'd after cutover were dedicated disposable acceptance artifacts with no production user result. The synthetic canary commit `a031ed48941702bf2dd04400fc707db55785658e` is protected by its canonical/safety refs and the successful recovery-worktree proof; the smoke Tasks were `NO_CHANGE`. The pre-cutover database backup does not promise their later Task/Run/Audit rows. The 38 historical production Tasks are covered by the pre-cutover backup and its isolated restore proof.

The GC operations completed before the retained final-process smoke—canary, historical batches, old-runtime smoke, and first Node 24 smoke—recorded 85,379,780 estimated reclaimable bytes in total. This estimate is not substituted for the controlled actual byte measurements above.

## Final service state

All three services were active and running after acceptance:

| Service | Main PID during acceptance | State |
| --- | ---: | --- |
| `agentdock-supervisor.service` | 2,002,330 | active/running |
| `agentdock-http.service` | 2,008,285 | active/running |
| `agentdock-mcp.service` | 2,002,376 | active/running |

The Supervisor and HTTP main processes and the MCP child process all resolved to `/opt/node-v24.21.0/bin/node`; the MCP Node child PID was 2,002,384. The CLI launcher and HTTP `ExecStartPost` were also pinned to that versioned binary, after which HTTP was restarted and its startup health gate passed. Core health on port 3100 reported `state_backend=sqlite`, `supervisor.ready=true`, `supervisor.mode=client`, and Supervisor instance `runtime_f3e5c69a-437c-42f6-bcd4-2263e671f8aa`. The OAuth proxy health endpoint on port 3400 returned `status=ok`. `agentdock doctor --json`, invoked through the final production launcher with the production environment loaded, returned overall `PASS`: Node 24.21.0, Git/worktree support, configuration and policy, writable state, SQLite integrity/schema, and live Supervisor connectivity all passed. Its state directory, backend, Supervisor mode/socket, and instance matched Core health. The production checkout matched `origin/main` and was clean at the implementation commit.

At the last read-only storage snapshot, the complete live state occupied 638,159,453 bytes, including 591,468,535 worktree bytes; the retained cutover backup occupied 689,348,279 bytes. After deleting only the verified Node download and restore staging directories, the filesystem had 10,062,557,184 bytes available (88% used). These later totals include the intentionally retained final smoke Task, concurrent Tasks created after the controlled historical-GC checkpoint, and the side-by-side Node 24 runtime; they do not authorize cleaning those Tasks.

## Retention and rollback boundary

The final Ticket 10 GC completed at `2026-09-25T15:11:41.704Z`. The complete backup and its external checksum manifests, the dedicated canary repository, all `refs/agentdock/gc-safety/*` refs, canonical Task refs, the two runtime/evidence backup directories, the exact Node 24 installation, code/config/unit evidence, and batch records must remain unchanged until at least `2026-10-02T15:11:41.704Z` (seven full 24-hour days after the last GC). Ticket 10 does not delete them automatically. Each safety ref has its own minimum seven-day lifetime from its Task's actual GC time; canonical Task refs are not part of the safety-ref expiry procedure and are not authorized for deletion here.

No later production GC may merely extend the old backup's deadline. After finalizing and selecting the intended Tasks but before that batch's final reconciliation/GC, operators must create a fresh quiesced checkpoint with the then-authoritative SQLite state, generate and verify the deterministic directory checksum manifest defined by the runbook, validate an isolated read-only restore using the exact deployed Node/code/config, and record the checkpoint path, checksum-manifest SHA-256, selected Task ids, expected SHAs, safety refs, `gc_completed_at`, and `retain_until` in a new manifest. If that checkpoint cannot be created and verified, the later GC must not run.

Rollback must follow `docs/production-cutover-and-gc.md`. Legacy JSON is not a current rollback authority after SQLite divergence, and a state-directory copy alone cannot recreate external repository worktree registrations. No Ticket 10 action removed ACTIVE Tasks, the 28 explicitly blocked Tasks, or the nine unrelated candidates observed during the first Node 24 smoke cleanup.
