import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { StateStore } from "../src/state-store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runWorker({ stateDir, iterations, workerId }) {
  const code = [
    "import {StateStore} from " + JSON.stringify(path.join(projectRoot, "src", "state-store.js")) + ";",
    "const store=new StateStore({stateDir:" + JSON.stringify(stateDir) + ",backend:'sqlite'});",
    "for(let i=0;i<" + iterations + ";i++){",
    " store.mutateDocument('probe','counter',(current)=>({value:Number(current?.value??0)+1,last_writer:" + JSON.stringify(workerId) + "}),{defaultValue:{value:0,last_writer:null}});",
    "}",
    "store.close?.();",
  ].join("");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(workerId + " failed: " + stderr));
    });
  });
}

test("v0.4 state backend defaults to json and supports explicit sqlite", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-state-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const defaults = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {},
  });
  assert.equal(defaults.config.state.backend, "json");

  const selected = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: path.join(root, "state"),
      AGENTDOCK_STATE_BACKEND: "sqlite",
    },
  });
  assert.equal(selected.config.state.backend, "sqlite");
  assert.equal(
    selected.metadata.env_overrides.includes("AGENTDOCK_STATE_BACKEND"),
    true,
  );
});

test("v0.4 sqlite StateStore imports legacy JSON idempotently", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-state-import-"));
  const stateDir = path.join(root, "state");
  await mkdir(path.join(stateDir, "tasks"), { recursive: true });
  await mkdir(path.join(stateDir, "audits"), { recursive: true });

  const task = {
    task_id: "task_00000000-0000-0000-0000-000000000001",
    status: "ACTIVE",
    source_repo: "/tmp/example",
  };
  const audit = {
    task_id: task.task_id,
    next_sequence: 2,
    entries: [{ sequence: 1, task_id: task.task_id, event: "LEGACY" }],
  };
  await writeFile(
    path.join(stateDir, "tasks", task.task_id + ".json"),
    JSON.stringify(task),
  );
  await writeFile(
    path.join(stateDir, "audits", task.task_id + ".json"),
    JSON.stringify(audit),
  );

  const store = new StateStore({ stateDir, backend: "sqlite" });
  t.after(async () => {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(store.backend, "sqlite");
  assert.deepEqual(store.loadTask(task.task_id), task);
  assert.deepEqual(store.loadAudit(task.task_id), audit);

  store.saveTask({ ...task, status: "COMPLETED" });
  assert.equal(store.loadTask(task.task_id).status, "COMPLETED");

  store.importLegacyJson?.();
  assert.equal(
    store.loadTask(task.task_id).status,
    "COMPLETED",
    "repeat import must not overwrite canonical sqlite state",
  );
});

test("v0.4 sqlite mutateDocument serializes cross-process updates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-state-race-"));
  const stateDir = path.join(root, "state");
  const store = new StateStore({ stateDir, backend: "sqlite" });
  store.saveDocument("probe", "counter", { value: 0, last_writer: null });
  store.close?.();

  t.after(async () => rm(root, { recursive: true, force: true }));

  await Promise.all([
    runWorker({ stateDir, iterations: 200, workerId: "stdio" }),
    runWorker({ stateDir, iterations: 200, workerId: "http" }),
  ]);

  const verify = new StateStore({ stateDir, backend: "sqlite" });
  const counter = verify.loadDocument("probe", "counter");
  assert.equal(counter.value, 400);
  assert.ok(["stdio", "http"].includes(counter.last_writer));
  assert.equal(verify.integrityCheck(), "ok");
  verify.close?.();
});
