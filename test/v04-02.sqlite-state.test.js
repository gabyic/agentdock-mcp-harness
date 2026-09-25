import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";
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

  const runtime = createAgentDockRuntime({ config: selected.config });
  assert.equal(runtime.stateStore.backend, "sqlite");
  await runtime.processService.shutdownOwned({ graceMs: 0, killWaitMs: 0 });
  runtime.stateStore.close?.();
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
  const taskPath = path.join(stateDir, "tasks", task.task_id + ".json");
  const auditPath = path.join(stateDir, "audits", task.task_id + ".json");
  const taskRaw = JSON.stringify(task);
  const auditRaw = JSON.stringify(audit);
  await writeFile(taskPath, taskRaw);
  await writeFile(auditPath, auditRaw);

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
  assert.equal(await readFile(taskPath, "utf8"), taskRaw);
  assert.equal(await readFile(auditPath, "utf8"), auditRaw);
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

test("v0.4 sqlite backend is consumed by the real runtime Task and Run path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-state-runtime-"));
  const repoDir = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  await mkdir(repoDir, { recursive: true });
  execFileSync("git", ["-C", repoDir, "init", "-b", "main"]);
  await writeFile(path.join(repoDir, "README.md"), "sqlite runtime\n");
  execFileSync("git", ["-C", repoDir, "add", "-A"]);
  execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "-c",
      "user.name=AgentDock Test",
      "-c",
      "user.email=agentdock-test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
  );

  const selected = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
    },
  });
  const runtime = createAgentDockRuntime({ config: selected.config });
  let task;

  t.after(async () => {
    if (task?.status === "ACTIVE") {
      runtime.taskService.cancel(task.task_id);
      await runtime.taskService.cleanup(task.task_id);
    }
    await runtime.processService.shutdownOwned({ graceMs: 0, killWaitMs: 0 });
    runtime.stateStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(runtime.stateStore.backend, "sqlite");
  task = await runtime.taskService.create({ repoPath: repoDir });
  const started = await runtime.processService.start({
    taskId: task.task_id,
    shell: "printf sqlite-runtime",
  });

  let terminal;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    terminal = runtime.processService.status({
      taskId: task.task_id,
      processId: started.process_id,
    });
    if (terminal.status === "EXITED") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(terminal?.status, "EXITED");
  assert.equal(terminal.exit_code, 0);
  const output = runtime.processService.output({
    taskId: task.task_id,
    processId: started.process_id,
    cursor: 0,
  });
  assert.equal(output.stdout_chunk, "sqlite-runtime");
  assert.equal(
    runtime.stateStore.loadProcess(started.process_id)?.status,
    "EXITED",
  );
});
