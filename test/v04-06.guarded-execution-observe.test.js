import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadAgentDockConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor-service.js";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentDock Test",
      GIT_AUTHOR_EMAIL: "agentdock@example.invalid",
      GIT_COMMITTER_NAME: "AgentDock Test",
      GIT_COMMITTER_EMAIL: "agentdock@example.invalid",
    },
  });
}

async function waitForExit(runtime, taskId, processId) {
  for (let i = 0; i < 100; i += 1) {
    const status = runtime.processService.status({
      taskId,
      processId,
    });
    if (!["RUNNING", "CANCELLING"].includes(status.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process did not exit");
}

test("v0.4: guarded execution observe classifies workspace and host without changing execution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-guard-observe-"));
  const repo = path.join(root, "repo");
  const hostDir = path.join(root, "host");
  const stateDir = path.join(root, "state");
  const fakeBwrap = path.join(root, "bwrap");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(repo);
  await mkdir(hostDir);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  await writeFile(fakeBwrap, "#!/bin/sh\nprintf 'bubblewrap 0.9.0\\n'\n");
  await chmod(fakeBwrap, 0o755);

  const { config } = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_GUARDED_EXECUTION_MODE: "observe",
      AGENTDOCK_SANDBOX_BINARY: fakeBwrap,
    },
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });

  const workspaceProcess = await runtime.processService.start({
    taskId: task.task_id,
    argv: ["/usr/bin/printf", "workspace-ok"],
    cwd: ".",
  });
  assert.equal(workspaceProcess.execution_plan.guarded_mode, "observe");
  assert.equal(workspaceProcess.execution_plan.lane, "WORKSPACE");
  assert.equal(workspaceProcess.execution_plan.decision, "would_sandbox");
  assert.equal(workspaceProcess.execution_plan.sandbox.ready, false);
  const workspaceExit = await waitForExit(
    runtime,
    task.task_id,
    workspaceProcess.process_id,
  );
  assert.equal(workspaceExit.exit_code, 0);

  const hostProcess = await runtime.processService.start({
    taskId: task.task_id,
    argv: ["/usr/bin/printf", "host-ok"],
    cwd: hostDir,
  });
  assert.equal(hostProcess.execution_plan.lane, "HOST");
  assert.equal(hostProcess.execution_plan.decision, "would_confirm");
  const hostExit = await waitForExit(
    runtime,
    task.task_id,
    hostProcess.process_id,
  );
  assert.equal(hostExit.exit_code, 0);

  const audit = runtime.auditService.get(task.task_id);
  const decisions = audit.entries.filter(
    (entry) => entry.event === "GUARDED_EXECUTION_DECISION",
  );
  assert.equal(decisions.length, 2);
  assert.deepEqual(
    decisions.map((entry) => [entry.lane, entry.decision]),
    [
      ["WORKSPACE", "would_sandbox"],
      ["HOST", "would_confirm"],
    ],
  );

  runtime.stateStore.close?.();
});

test("v0.4: enforce fails closed when sandbox runtime is below supported version", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-guard-enforce-"));
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  const fakeBwrap = path.join(root, "bwrap");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(repo);
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  await writeFile(fakeBwrap, "#!/bin/sh\nprintf 'bubblewrap 0.9.0\\n'\n");
  await chmod(fakeBwrap, 0o755);

  const { config } = loadAgentDockConfig({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_GUARDED_EXECUTION_MODE: "enforce",
      AGENTDOCK_SANDBOX_BINARY: fakeBwrap,
    },
  });
  const runtime = createAgentDockRuntime({ config });
  const task = await runtime.taskService.create({ repoPath: repo });

  await assert.rejects(
    runtime.processService.start({
      taskId: task.task_id,
      argv: ["/usr/bin/printf", "must-not-run"],
      cwd: ".",
    }),
    (error) => error?.code === "GUARDED_EXECUTION_SANDBOX_UNSAFE",
  );
  assert.equal(task.process_ids.length, 0);

  runtime.stateStore.close?.();
});

test("v0.4: doctor exposes guarded-execution mode and sandbox readiness", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentdock-v04-guard-doctor-"));
  const fakeBwrap = path.join(root, "bwrap");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(fakeBwrap, "#!/bin/sh\nprintf 'bubblewrap 0.9.0\\n'\n");
  await chmod(fakeBwrap, 0o755);

  const report = await runDoctor({
    homeDir: root,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: path.join(root, "state"),
      AGENTDOCK_GUARDED_EXECUTION_MODE: "observe",
      AGENTDOCK_SANDBOX_BINARY: fakeBwrap,
    },
  });
  const guarded = report.checks.find(
    (entry) => entry.id === "guarded_execution",
  );
  assert.equal(guarded.status, "WARN");
  assert.equal(guarded.details.mode, "observe");
  assert.equal(guarded.details.sandbox.version, "0.9.0");
  assert.equal(guarded.details.sandbox.ready, false);
});
