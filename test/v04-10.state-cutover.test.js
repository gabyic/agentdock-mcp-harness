import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoOpenStateHandles,
  findOpenStateHandles,
  runStateCutover,
} from "../scripts/state-cutover.mjs";
import {
  LEGACY_IMPORT_MARKER_ID,
  StateStore,
} from "../src/state-store.js";

async function isolatedProcRoot(root) {
  const procRoot = path.join(root, "proc-fixture");
  await mkdir(procRoot, { recursive: true });
  return procRoot;
}

test("v0.4 state cutover creates a rollback backup and cross-checks every legacy identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-cutover-"));
  const stateDir = path.join(root, "state");
  const backupDir = path.join(root, "backups", "before-sqlite");
  const taskId = "task_00000000-0000-4000-8000-000000000010";
  const processId = "proc_00000000-0000-4000-8000-000000000010";
  const fixtures = [
    ["tasks", taskId, { task_id: taskId, status: "ACTIVE", process_ids: [processId] }],
    ["processes", processId, { process_id: processId, task_id: taskId, status: "EXITED", output: [], env: {} }],
    ["audits", taskId, { task_id: taskId, next_sequence: 1, entries: [] }],
    ["workflows", "workflow_cutover", { workflow_id: "workflow_cutover", task_id: taskId, status: "ACTIVE" }],
    [path.join("documents", "plan"), "plan_cutover", { plan_id: "plan_cutover", task_id: taskId, status: "COMPLETED" }],
    [path.join("documents", "operation"), "op_cutover", { operation_id: "op_cutover", task_id: taskId, status: "EXITED" }],
  ];
  for (const [directory, id, value] of fixtures) {
    await mkdir(path.join(stateDir, directory), { recursive: true });
    await writeFile(path.join(stateDir, directory, id + ".json"), JSON.stringify(value) + "\n");
  }
  t.after(async () => rm(root, { recursive: true, force: true }));

  const procRoot = await isolatedProcRoot(root);
  const result = await runStateCutover({
    stateDir,
    backupDir,
    maintenanceConfirmed: true,
    existingSqliteAuthoritative: false,
  }, { procRoot });
  assert.equal(result.status, "PASS");
  assert.equal(result.cutover_mode, "INITIAL_JSON_IMPORT");
  assert.equal(result.report.integrity_check, "ok");
  assert.equal(result.report.identity_complete, true);
  assert.equal(result.report.content_matches_legacy, true);
  assert.equal(result.report.legacy_document_count, 6);
  assert.equal(result.previous_cutover_verified, false);

  const verified = new StateStore({ stateDir, backend: "sqlite", importLegacy: false });
  assert.equal(
    verified.loadDocument("system", LEGACY_IMPORT_MARKER_ID)?.verified,
    true,
  );
  verified.close();

  for (const [directory, id] of fixtures) {
    assert.equal(
      await readFile(path.join(backupDir, directory, id + ".json"), "utf8"),
      await readFile(path.join(stateDir, directory, id + ".json"), "utf8"),
    );
  }

  const sqlite = new StateStore({ stateDir, backend: "sqlite" });
  sqlite.saveTask({ ...sqlite.loadTask(taskId), status: "COMPLETED" });
  const diverged = sqlite.legacyImportReport();
  assert.equal(diverged.identity_complete, true);
  assert.equal(diverged.content_matches_legacy, false);
  sqlite.close();

  const secondBackup = path.join(root, "backups", "existing-sqlite");
  const existing = await runStateCutover({
    stateDir,
    backupDir: secondBackup,
    maintenanceConfirmed: true,
    existingSqliteAuthoritative: false,
  }, { procRoot });
  assert.equal(existing.status, "PASS");
  assert.equal(existing.cutover_mode, "EXISTING_SQLITE_BACKUP");
  assert.equal(existing.report.identity_complete, true);
  assert.equal(existing.report.content_matches_legacy, false);
  assert.equal(existing.previous_cutover_verified, true);

  const isolatedRestore = path.join(root, "isolated-existing-sqlite-restore");
  await cp(secondBackup, isolatedRestore, { recursive: true });
  const restored = new StateStore({
    stateDir: isolatedRestore,
    backend: "sqlite",
    importLegacy: false,
  });
  assert.equal(restored.integrityCheck(), "ok");
  assert.equal(restored.loadTask(taskId).status, "COMPLETED");
  assert.equal(
    restored.loadDocument("system", LEGACY_IMPORT_MARKER_ID)?.verified,
    true,
  );
  restored.close();

  const missing = new StateStore({ stateDir, backend: "sqlite" });
  missing.deleteDocument("task", taskId);
  missing.close();
  const failed = await runStateCutover({
    stateDir,
    backupDir: path.join(root, "backups", "missing-identity"),
    maintenanceConfirmed: true,
    existingSqliteAuthoritative: false,
  }, { procRoot });
  assert.equal(failed.status, "FAIL");
  assert.equal(failed.report.identity_complete, false);
  const verifyMissing = new StateStore({ stateDir, backend: "sqlite" });
  assert.equal(verifyMissing.loadTask(taskId), null, "existing SQLite must not re-import legacy JSON on open");
  verifyMissing.close();

  const isolatedJsonRestore = path.join(root, "isolated-initial-json-restore");
  await cp(backupDir, isolatedJsonRestore, { recursive: true });
  const rollback = new StateStore({
    stateDir: isolatedJsonRestore,
    backend: "json",
  });
  assert.equal(rollback.loadTask(taskId).status, "ACTIVE");
  rollback.close();
});

test("v0.4 state cutover refuses a live writer lease before creating backup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-cutover-live-"));
  const stateDir = path.join(root, "state");
  const leasesDir = path.join(stateDir, "runtime-leases");
  await mkdir(leasesDir, { recursive: true });
  await writeFile(path.join(leasesDir, "runtime-live.json"), JSON.stringify({
    instance_id: "runtime_00000000-0000-4000-8000-000000000010",
    pid: process.pid,
    heartbeat_at: "2000-01-01T00:00:00.000Z",
  }));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const procRoot = await isolatedProcRoot(root);
  let failure;
  await assert.rejects(
    runStateCutover({
      stateDir,
      backupDir: path.join(root, "backup"),
      maintenanceConfirmed: true,
      existingSqliteAuthoritative: false,
    }, { procRoot }),
    (error) => {
      failure = error;
      return true;
    },
  );
  assert.equal(failure.code, "STATE_WRITER_ACTIVE");
  assert.equal(failure.details.live_runtime_leases[0].heartbeat_stale, true);
  await assert.rejects(readFile(path.join(root, "backup", "runtime-leases", "runtime-live.json")), { code: "ENOENT" });
});

test("v0.4 state cutover requires an explicit authority acknowledgement for an unmarked existing database", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-cutover-unmarked-"));
  const stateDir = path.join(root, "state");
  const taskId = "task_00000000-0000-4000-8000-000000000020";
  const task = { task_id: taskId, status: "ACTIVE", process_ids: [] };
  await mkdir(path.join(stateDir, "tasks"), { recursive: true });
  await writeFile(path.join(stateDir, "tasks", taskId + ".json"), JSON.stringify(task) + "\n");
  const sqlite = new StateStore({ stateDir, backend: "sqlite", importLegacy: true });
  assert.deepEqual(sqlite.loadTask(taskId), task);
  assert.equal(sqlite.loadDocument("system", LEGACY_IMPORT_MARKER_ID), null);
  sqlite.close();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const procRoot = await isolatedProcRoot(root);
  const refusedBackup = path.join(root, "backups", "refused");
  let refusal;
  await assert.rejects(
    runStateCutover({
      stateDir,
      backupDir: refusedBackup,
      maintenanceConfirmed: true,
      existingSqliteAuthoritative: false,
    }, { procRoot }),
    (error) => {
      refusal = error;
      return true;
    },
  );
  assert.equal(refusal.code, "EXISTING_SQLITE_AUTHORITY_UNCONFIRMED");
  await assert.rejects(readFile(path.join(refusedBackup, "agentdock.db")), { code: "ENOENT" });

  const accepted = await runStateCutover({
    stateDir,
    backupDir: path.join(root, "backups", "accepted"),
    maintenanceConfirmed: true,
    existingSqliteAuthoritative: true,
  }, { procRoot });
  assert.equal(accepted.status, "PASS");
  assert.equal(accepted.cutover_mode, "EXISTING_SQLITE_BACKUP");
  assert.equal(accepted.existing_sqlite_authoritative_confirmed, true);
  const marked = new StateStore({ stateDir, backend: "sqlite", importLegacy: false });
  assert.equal(marked.loadDocument("system", LEGACY_IMPORT_MARKER_ID)?.verified, true);
  marked.close();
});

test("v0.4 state cutover rejects unsupported legacy JSON filenames without marking import verified", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-cutover-invalid-"));
  const stateDir = path.join(root, "state");
  await mkdir(path.join(stateDir, "tasks"), { recursive: true });
  await writeFile(path.join(stateDir, "tasks", "bad task id.json"), "{}\n");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const procRoot = await isolatedProcRoot(root);
  let failure;
  await assert.rejects(
    runStateCutover({
      stateDir,
      backupDir: path.join(root, "backup"),
      maintenanceConfirmed: true,
      existingSqliteAuthoritative: false,
    }, { procRoot }),
    (error) => {
      failure = error;
      return true;
    },
  );
  assert.equal(failure.code, "INVALID_LEGACY_STATE_FILENAME");
  const sqlite = new StateStore({ stateDir, backend: "sqlite", importLegacy: false });
  assert.equal(sqlite.loadDocument("system", LEGACY_IMPORT_MARKER_ID), null);
  sqlite.close();
});

test("v0.4 Linux proc scan rejects same-user handles inside state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-cutover-proc-"));
  const stateDir = path.join(root, "state");
  const procRoot = path.join(root, "proc");
  const fdDir = path.join(procRoot, "4242", "fd");
  const databasePath = path.join(stateDir, "agentdock.db");
  await mkdir(stateDir, { recursive: true });
  await writeFile(databasePath, "fixture\n");
  await mkdir(fdDir, { recursive: true });
  await symlink(databasePath, path.join(fdDir, "7"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = await findOpenStateHandles({
    stateDir,
    procRoot,
    uid: process.getuid?.(),
  });
  assert.deepEqual(scan.handles, [{
    pid: 4242,
    fd: "7",
    path: await realpath(databasePath),
  }]);
  await assert.rejects(
    assertNoOpenStateHandles({ stateDir, procRoot, uid: process.getuid?.() }),
    { code: "STATE_WRITER_HANDLE_OPEN" },
  );
});
