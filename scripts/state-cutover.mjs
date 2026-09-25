#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  LEGACY_IMPORT_MARKER_ID,
  StateStore,
} from "../src/state-store.js";

function usage() {
  return [
    "Usage: node scripts/state-cutover.mjs --state-dir PATH --backup-dir PATH --maintenance-confirmed [--existing-sqlite-authoritative]",
    "",
    "All AgentDock writers must be stopped before this command is run.",
    "The backup directory must not already exist and must be outside the state directory.",
    "Use --existing-sqlite-authoritative only to acknowledge a pre-existing, unmarked authoritative SQLite database.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    maintenanceConfirmed: false,
    existingSqliteAuthoritative: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--maintenance-confirmed") {
      options.maintenanceConfirmed = true;
    } else if (arg === "--existing-sqlite-authoritative") {
      options.existingSqliteAuthoritative = true;
    } else if (arg === "--state-dir" || arg === "--backup-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(arg + " requires a path.");
      index += 1;
      if (arg === "--state-dir") options.stateDir = path.resolve(value);
      else options.backupDir = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage() + "\n");
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }
  if (!options.stateDir || !options.backupDir) {
    throw new Error("--state-dir and --backup-dir are required.");
  }
  if (!options.maintenanceConfirmed) {
    throw new Error("Refusing cutover without --maintenance-confirmed.");
  }
  return options;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function cutoverError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function readVerifiedImportMarker(databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_documents'",
      )
      .get();
    if (!table) return null;
    const row = database
      .prepare(
        "SELECT value_json FROM state_documents WHERE kind = 'system' AND id = ?",
      )
      .get(LEGACY_IMPORT_MARKER_ID);
    if (!row) return null;
    const marker = JSON.parse(row.value_json);
    return marker?.verified === true ? marker : null;
  } finally {
    database?.close();
  }
}

export async function assertNoLiveRuntimeLease(stateDir) {
  const leasesDir = path.join(stateDir, "runtime-leases");
  let entries = [];
  try {
    entries = await readdir(leasesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const live = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const lease = JSON.parse(await readFile(path.join(leasesDir, entry.name), "utf8"));
    const pid = Number(lease.pid);
    const heartbeat = Date.parse(lease.heartbeat_at ?? "");
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      live.push({
        instance_id: lease.instance_id ?? entry.name,
        pid,
        heartbeat_at: lease.heartbeat_at ?? null,
        heartbeat_stale:
          !Number.isFinite(heartbeat) || Date.now() - heartbeat > 60_000,
      });
    } catch (error) {
      if (error?.code === "EPERM") {
        live.push({
          instance_id: lease.instance_id ?? entry.name,
          pid,
          heartbeat_at: lease.heartbeat_at ?? null,
          heartbeat_stale:
            !Number.isFinite(heartbeat) || Date.now() - heartbeat > 60_000,
        });
      } else if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  if (live.length > 0) {
    throw cutoverError(
      "STATE_WRITER_ACTIVE",
      "A live AgentDock runtime lease exists; stop all writers before cutover.",
      { live_runtime_leases: live },
    );
  }
}

export async function findOpenStateHandles({
  stateDir,
  procRoot = "/proc",
  uid = process.getuid?.(),
} = {}) {
  const stateRoot = await realpath(stateDir);
  const handles = [];
  const incompletePids = [];
  let processes;
  try {
    processes = await readdir(procRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw cutoverError(
        "PROC_HANDLE_SCAN_UNAVAILABLE",
        "Linux /proc is unavailable; writer handle verification cannot run.",
        { proc_root: procRoot },
      );
    }
    throw error;
  }

  for (const entry of processes) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const processPath = path.join(procRoot, entry.name);
    let processInfo;
    try {
      processInfo = await stat(processPath);
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
      throw error;
    }
    if (uid !== undefined && processInfo.uid !== uid) continue;

    const fdDir = path.join(processPath, "fd");
    let descriptors;
    try {
      descriptors = await readdir(fdDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (["EACCES", "EPERM"].includes(error?.code)) {
        incompletePids.push(pid);
        continue;
      }
      throw error;
    }

    for (const descriptor of descriptors) {
      const descriptorPath = path.join(fdDir, descriptor.name);
      let target;
      try {
        target = await readlink(descriptorPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        if (["EACCES", "EPERM"].includes(error?.code)) {
          incompletePids.push(pid);
          continue;
        }
        throw error;
      }
      const normalized = target.endsWith(" (deleted)")
        ? target.slice(0, -" (deleted)".length)
        : target;
      if (!path.isAbsolute(normalized)) continue;
      let physicalTarget = normalized;
      try {
        physicalTarget = await realpath(normalized);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!inside(stateRoot, physicalTarget)) continue;
      handles.push({ pid, fd: descriptor.name, path: physicalTarget });
    }
  }

  return {
    handles,
    incomplete_pids: [...new Set(incompletePids)].sort((left, right) => left - right),
  };
}

export async function assertNoOpenStateHandles(options) {
  const result = await findOpenStateHandles(options);
  if (result.incomplete_pids.length > 0) {
    throw cutoverError(
      "STATE_HANDLE_SCAN_INCOMPLETE",
      "Could not inspect every same-user process for open state handles.",
      result,
    );
  }
  if (result.handles.length > 0) {
    throw cutoverError(
      "STATE_WRITER_HANDLE_OPEN",
      "A process still has an open handle inside the AgentDock state directory.",
      result,
    );
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (inside(options.stateDir, options.backupDir)) {
    throw new Error("Backup directory must be outside the state directory.");
  }
  if (existsSync(options.backupDir)) {
    throw new Error("Backup directory already exists: " + options.backupDir);
  }
  const stateInfo = await stat(options.stateDir);
  if (!stateInfo.isDirectory()) throw new Error("State path is not a directory.");

  await assertNoLiveRuntimeLease(options.stateDir);
  if (process.platform === "linux") {
    await assertNoOpenStateHandles({ stateDir: options.stateDir });
  }

  const databasePath = path.join(options.stateDir, "agentdock.db");
  const databaseExisted = existsSync(databasePath);
  const previousMarker = databaseExisted
    ? readVerifiedImportMarker(databasePath)
    : null;
  if (databaseExisted && !previousMarker && !options.existingSqliteAuthoritative) {
    throw cutoverError(
      "EXISTING_SQLITE_AUTHORITY_UNCONFIRMED",
      "Existing unverified SQLite state requires --existing-sqlite-authoritative after operator review.",
      { database_path: databasePath },
    );
  }
  if (!databaseExisted && options.existingSqliteAuthoritative) {
    throw cutoverError(
      "EXISTING_SQLITE_NOT_FOUND",
      "--existing-sqlite-authoritative requires a pre-existing SQLite database.",
      { database_path: databasePath },
    );
  }

  await mkdir(path.dirname(options.backupDir), { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(options.stateDir);
  const backupParent = await realpath(path.dirname(options.backupDir));
  const physicalBackupDir = path.join(backupParent, path.basename(options.backupDir));
  if (inside(stateRoot, physicalBackupDir)) {
    throw new Error("Backup directory must be physically outside the state directory.");
  }
  await cp(options.stateDir, options.backupDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await assertNoLiveRuntimeLease(options.stateDir);
  if (process.platform === "linux") {
    await assertNoOpenStateHandles({ stateDir: options.stateDir });
  }

  const store = new StateStore({
    stateDir: options.stateDir,
    backend: "sqlite",
    importLegacy: !databaseExisted,
  });
  let report;
  let accepted = false;
  try {
    report = store.legacyImportReport();
    const initialCutover = !databaseExisted;
    accepted = report.integrity_check === "ok" &&
      report.identity_complete &&
      (!initialCutover || report.content_matches_legacy);
    if (accepted) {
      store.markLegacyImportComplete({
        cutover_mode: initialCutover ? "INITIAL_JSON_IMPORT" : "EXISTING_SQLITE_BACKUP",
        existing_sqlite_authoritative_confirmed:
          databaseExisted && !previousMarker
            ? options.existingSqliteAuthoritative
            : false,
        legacy_document_count: report.legacy_document_count,
        sqlite_document_count: report.sqlite_document_count,
      });
    }
  } finally {
    store.close();
  }

  const initialCutover = !databaseExisted;
  const output = {
    status: accepted ? "PASS" : "FAIL",
    cutover_mode: initialCutover ? "INITIAL_JSON_IMPORT" : "EXISTING_SQLITE_BACKUP",
    state_dir: options.stateDir,
    backup_dir: options.backupDir,
    backup_created: true,
    rollback_source: options.backupDir,
    previous_cutover_verified: Boolean(previousMarker),
    existing_sqlite_authoritative_confirmed:
      databaseExisted && !previousMarker
        ? options.existingSqliteAuthoritative
        : false,
    report,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (!accepted) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      status: "FAIL",
      code: error?.code ?? "STATE_CUTOVER_FAILED",
      message: error?.message ?? String(error),
      details: error?.details ?? null,
    }) + "\n");
    process.exitCode = 1;
  });
}
