import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runWorker(workerPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error("worker failed code=" + code + " stderr=" + stderr));
    });
  });
}

test("v0.4: sqlite workflow updates from independent runtimes do not lose state or history", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-workflow-state-"));
  const stateDir = path.join(tempRoot, "state");
  const project = path.join(tempRoot, "project");
  const worker = path.join(tempRoot, "worker.mjs");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(path.join(project, "docs", "agents"), { recursive: true });
  await writeFile(path.join(project, "docs", "agents", "issue-tracker.md"), "# tracker\n");
  await writeFile(path.join(project, "docs", "agents", "domain.md"), "# domain\n");
  await writeFile(path.join(project, "AGENTS.md"), "# Agent\n\n## Agent skills\n");

  const { config } = loadAgentDockConfig({
    homeDir: tempRoot,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_STATE_BACKEND: "sqlite",
    },
  });
  const runtime = createAgentDockRuntime({ config });
  await runtime.workflowService.start({
    repoPath: project,
    goal: "Prove transactional workflow updates.",
    sessionSpan: "single",
    routeClarity: "clear",
  });

  await writeFile(
    worker,
    [
      "import { loadAgentDockConfig } from " + JSON.stringify(path.join(projectRoot, "src", "config.js")) + ";",
      "import { createAgentDockRuntime } from " + JSON.stringify(path.join(projectRoot, "src", "server.js")) + ";",
      "const [stateDir, repoPath, key, value, note] = process.argv.slice(2);",
      "const { config } = loadAgentDockConfig({ configPath: null, env: { AGENTDOCK_STATE_DIR: stateDir, AGENTDOCK_STATE_BACKEND: 'sqlite' } });",
      "const runtime = createAgentDockRuntime({ config });",
      "await runtime.workflowService.update({ repoPath, artifacts: { [key]: value }, note });",
      "runtime.stateStore.close?.();",
    ].join("\n"),
  );

  await Promise.all([
    runWorker(worker, [stateDir, project, "a", "A", "worker-A"]),
    runWorker(worker, [stateDir, project, "b", "B", "worker-B"]),
  ]);

  const finalWorkflow = await runtime.workflowService.get({ repoPath: project });
  assert.deepEqual(finalWorkflow.artifacts, { a: "A", b: "B" });
  const notes = finalWorkflow.history.map((entry) => entry.note).filter(Boolean);
  assert.equal(notes.includes("worker-A"), true);
  assert.equal(notes.includes("worker-B"), true);
  runtime.stateStore.close?.();
});
