import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function dataFrom(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP result should contain JSON text");
  return JSON.parse(text);
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitFor(check, timeoutMs = 7000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForHealth(port) {
  return waitFor(async () => {
    try {
      const response = await fetch(
        "http://127.0.0.1:" + port + "/healthz",
      );
      if (!response.ok) return null;
      const body = await response.json();
      return body.status === "ok" ? body : null;
    } catch {
      return null;
    }
  });
}

async function waitForDown(port) {
  return waitFor(async () => {
    try {
      await fetch("http://127.0.0.1:" + port + "/healthz");
      return null;
    } catch {
      return true;
    }
  });
}

async function waitForPidGone(pid) {
  return waitFor(async () => {
    try {
      process.kill(pid, 0);
      return null;
    } catch (error) {
      return error?.code === "ESRCH" ? true : null;
    }
  });
}

function cleanEnv(extra = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined && !key.startsWith("AGENTDOCK_"),
      ),
    ),
    ...extra,
  };
}

function spawnAgentDock({ stateDir, port }) {
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "src", "index.js")],
    {
      cwd: projectRoot,
      env: cleanEnv({
        AGENTDOCK_STATE_DIR: stateDir,
        AGENTDOCK_TRANSPORT: "http",
        AGENTDOCK_HTTP_HOST: "127.0.0.1",
        AGENTDOCK_HTTP_PORT: String(port),
      }),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return { child, stderr: () => stderr };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
}

async function openClient(port, label) {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:" + port + "/mcp"),
  );
  const client = new Client(
    { name: "agentdock-v02-06-" + label, version: "0.2.0-dev" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(transport);
  return { client, transport };
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", cwd, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return stdout.trimEnd();
}

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "AgentDock Service Test"]);
  await git(
    repo,
    ["config", "user.email", "agentdock-service@example.invalid"],
  );
  await writeFile(path.join(repo, "README.md"), "# service\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

async function startLongProcess(client, taskId, marker) {
  const started = dataFrom(
    await client.callTool({
      name: "process.start",
      arguments: {
        task_id: taskId,
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(" +
            JSON.stringify(marker + "\n") +
            "); setInterval(() => {}, 1000)",
        ],
        cwd: ".",
      },
    }),
  );

  await waitFor(async () => {
    const output = dataFrom(
      await client.callTool({
        name: "process.output",
        arguments: {
          task_id: taskId,
          process_id: started.process_id,
          cursor: 0,
        },
      }),
    );
    return output.stdout_chunk.includes(marker) ? output : null;
  });
  return started;
}

test("v0.2-06: planned restart is graceful, healthy again, and records owned process as CANCELLED", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-06-planned-"),
  );
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const port = await getFreePort();
  let server = spawnAgentDock({ stateDir, port });
  const clients = [];

  t.after(async () => {
    for (const entry of clients) {
      await entry.client.close().catch(() => {});
    }
    if (server?.child && server.child.exitCode === null) {
      server.child.kill("SIGKILL");
      await waitForExit(server.child);
    }
    await rm(root, { recursive: true, force: true });
  });

  await waitForHealth(port);
  const first = await openClient(port, "planned-first");
  clients.push(first);

  const tools = await first.client.listTools();
  assert.equal(tools.tools.length, 31);

  const task = dataFrom(
    await first.client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const running = await startLongProcess(
    first.client,
    task.task_id,
    "planned-ready",
  );

  const healthCli = await execFileAsync(
    process.execPath,
    [
      "src/cli.js",
      "health",
      "--url",
      "http://127.0.0.1:" + port + "/healthz",
      "--json",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: cleanEnv(),
    },
  );
  assert.equal(JSON.parse(healthCli.stdout).status, "PASS");

  server.child.kill("SIGTERM");
  const [code, signal] = await waitForExit(server.child);
  assert.equal(code, 0);
  assert.equal(signal, null);
  await waitForDown(port);
  await waitForPidGone(running.pid);
  assert.match(server.stderr(), /SIGTERM/);

  server = spawnAgentDock({ stateDir, port });
  await waitForHealth(port);

  const second = await openClient(port, "planned-second");
  clients.push(second);
  assert.equal((await second.client.listTools()).tools.length, 31);

  const resumed = dataFrom(
    await second.client.callTool({
      name: "task.resume",
      arguments: { task_id: task.task_id },
    }),
  );
  const restored = resumed.processes.find(
    (entry) => entry.process_id === running.process_id,
  );
  assert.ok(restored);
  assert.equal(restored.status, "CANCELLED");

  const audit = dataFrom(
    await second.client.callTool({
      name: "audit.get",
      arguments: {
        task_id: task.task_id,
        after_sequence: 0,
        limit: 100,
      },
    }),
  );
  assert.equal(
    audit.entries.some(
      (entry) =>
        entry.event === "PROCESS_CANCEL_REQUESTED" &&
        entry.process_id === running.process_id &&
        entry.reason === "service_shutdown",
    ),
    true,
  );
});

test("v0.2-06: hard crash recovers health and MCP while lost process ownership becomes INTERRUPTED", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-06-crash-"),
  );
  const stateDir = path.join(root, "state");
  const repo = await makeRepo(root);
  const port = await getFreePort();
  let server = spawnAgentDock({ stateDir, port });
  const clients = [];
  let taskProcessPid = null;

  t.after(async () => {
    for (const entry of clients) {
      await entry.client.close().catch(() => {});
    }
    if (server?.child && server.child.exitCode === null) {
      server.child.kill("SIGKILL");
      await waitForExit(server.child);
    }
    if (taskProcessPid) {
      try {
        process.kill(-taskProcessPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });

  await waitForHealth(port);
  const first = await openClient(port, "crash-first");
  clients.push(first);

  const task = dataFrom(
    await first.client.callTool({
      name: "task.create",
      arguments: { repo_path: repo },
    }),
  );
  const running = await startLongProcess(
    first.client,
    task.task_id,
    "crash-ready",
  );
  taskProcessPid = running.pid;

  server.child.kill("SIGKILL");
  const [code, signal] = await waitForExit(server.child);
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  await waitForDown(port);

  // systemd KillMode=control-group performs this cleanup in production.
  // The test harness emulates that cgroup cleanup for the detached Task group.
  try {
    process.kill(-running.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForPidGone(running.pid);
  taskProcessPid = null;

  server = spawnAgentDock({ stateDir, port });
  await waitForHealth(port);

  const second = await openClient(port, "crash-second");
  clients.push(second);
  assert.equal((await second.client.listTools()).tools.length, 31);

  const resumed = dataFrom(
    await second.client.callTool({
      name: "task.resume",
      arguments: { task_id: task.task_id },
    }),
  );
  const restored = resumed.processes.find(
    (entry) => entry.process_id === running.process_id,
  );
  assert.ok(restored);
  assert.equal(restored.status, "INTERRUPTED");
  assert.match(restored.error, /restarted|lost ownership/i);
});

test("v0.2-06: systemd unit contract enforces always-restart, cgroup kill, and health gate", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/verify-systemd-unit.mjs"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );
  assert.equal(stdout.trim(), "SYSTEMD_UNIT_CONTRACT=PASS");

  const unit = await (
    await import("node:fs/promises")
  ).readFile(
    path.join(
      projectRoot,
      "deploy",
      "systemd",
      "agentdock-http.service",
    ),
    "utf8",
  );

  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(
    unit,
    /^ExecStartPost=.*agentdock health --wait-ms 10000/m,
  );
});

test("v0.2-06: health wait gate retries until a delayed HTTP service becomes ready", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-06-health-wait-"),
  );
  const stateDir = path.join(root, "state");
  const port = await getFreePort();
  let server = null;

  t.after(async () => {
    if (server?.child && server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child);
    }
    await rm(root, { recursive: true, force: true });
  });

  const health = spawn(
    process.execPath,
    [
      "src/cli.js",
      "health",
      "--url",
      "http://127.0.0.1:" + port + "/healthz",
      "--wait-ms",
      "2500",
      "--timeout-ms",
      "100",
      "--json",
    ],
    {
      cwd: projectRoot,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  health.stdout.setEncoding("utf8");
  health.stderr.setEncoding("utf8");
  health.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  health.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  server = spawnAgentDock({ stateDir, port });

  const [code, signal] = await waitForExit(health);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, "");

  const result = JSON.parse(stdout);
  assert.equal(result.status, "PASS");
  assert.equal(result.healthy, true);
  assert.equal(result.attempts > 1, true);
  assert.equal(result.status_code, 200);
});

test("v0.2-06: health rejects secret-bearing URLs without echoing the secret", async () => {
  for (const [url, secret] of [
    ["http://user:DO_NOT_PRINT@127.0.0.1:9/healthz", "DO_NOT_PRINT"],
    ["http://127.0.0.1:9/healthz?token=DO_NOT_PRINT_QUERY", "DO_NOT_PRINT_QUERY"],
  ]) {
    let caught;
    try {
      await execFileAsync(
        process.execPath,
        ["src/cli.js", "health", "--url", url, "--json"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: cleanEnv(),
        },
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught);
    assert.equal(caught.code, 1);
    assert.equal(caught.stderr, "");
    assert.equal(caught.stdout.includes(secret), false);
    const result = JSON.parse(caught.stdout);
    assert.equal(result.status, "FAIL");
  }
});
