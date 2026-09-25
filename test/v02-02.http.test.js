import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { listenAgentDockHttp } from "../src/http-server.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}

function dataFrom(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP result should contain JSON text");
  return JSON.parse(text);
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function rawGet({ port, path: requestPath, hostHeader, origin }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: {
          Host: hostHeader,
          ...(origin ? { Origin: origin } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("v0.2-02: native stateless Streamable HTTP preserves shared runtime and host guards", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-02-"));
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "state");

  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock HTTP Test"]);
  await git(
    repoDir,
    ["config", "user.email", "agentdock-http@example.invalid"],
  );
  await writeFile(path.join(repoDir, "README.md"), "# http\n", "utf8");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "fixture"]);

  const sourceHead = await git(repoDir, ["rev-parse", "HEAD"]);

  const instance = await listenAgentDockHttp({
    host: "127.0.0.1",
    port: 0,
    stateDir,
  });

  const endpoint = new URL(
    "http://127.0.0.1:" + instance.port + instance.mcpPath,
  );
  const transport = new StreamableHTTPClientTransport(endpoint);
  const client = new Client(
    { name: "agentdock-v02-02-http", version: "0.2.0-dev" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  const legacyTransport = new StreamableHTTPClientTransport(endpoint);
  const legacyClient = new Client(
    { name: "agentdock-v02-02-http-legacy", version: "0.2.0-dev" },
    { capabilities: {} },
  );

  t.after(async () => {
    await Promise.allSettled([
      client.close(),
      legacyClient.close(),
      instance.close(),
    ]);
    try {
      const worktrees = await git(repoDir, ["worktree", "list", "--porcelain"]);
      for (const block of worktrees.split("\n\n")) {
        const line = block
          .split("\n")
          .find((entry) => entry.startsWith("worktree "));
        const worktree = line?.slice("worktree ".length);
        if (worktree && path.resolve(worktree) !== path.resolve(repoDir)) {
          await git(repoDir, ["worktree", "remove", "--force", worktree]);
        }
      }
    } catch {
      // Best effort temp cleanup.
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await rawGet({
    port: instance.port,
    path: instance.healthPath,
    hostHeader: "127.0.0.1:" + instance.port,
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), {
    status: "ok",
    transport: "streamable-http",
    mode: "stateless",
    state_backend: "sqlite",
    supervisor: {
      ready: true,
      mode: "owner",
      instance_id: instance.runtime.processService.instanceId,
    },
  });

  const blocked = await rawGet({
    port: instance.port,
    path: instance.healthPath,
    hostHeader: "attacker.invalid",
  });
  assert.equal(blocked.statusCode, 403);

  const blockedOrigin = await rawGet({
    port: instance.port,
    path: instance.healthPath,
    hostHeader: "127.0.0.1:" + instance.port,
    origin: "https://attacker.invalid",
  });
  assert.equal(blockedOrigin.statusCode, 403);

  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(transport.sessionId, undefined);

  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "task.create"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "plan.start"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "plan.get"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "plan.cancel"), true);

  await legacyClient.connect(legacyTransport);
  assert.equal(legacyClient.getProtocolEra(), "legacy");
  assert.equal(legacyTransport.sessionId, undefined);
  const legacyTools = await legacyClient.listTools();
  assert.deepEqual(
    legacyTools.tools.map((tool) => tool.name).sort(),
    tools.tools.map((tool) => tool.name).sort(),
  );

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );
  assert.equal(task.base_head, sourceHead);

  const started = dataFrom(
    await client.callTool({
      name: "process.start",
      arguments: {
        task_id: task.task_id,
        argv: [
          process.execPath,
          "-e",
          "setTimeout(() => process.stdout.write('done\\n'), 1200)",
        ],
        cwd: ".",
      },
    }),
  );
  assert.equal(started.status, "RUNNING");

  // This is a separate HTTP request. Shared runtime ownership must preserve
  // RUNNING rather than restoring the snapshot as INTERRUPTED.
  const running = dataFrom(
    await client.callTool({
      name: "process.status",
      arguments: {
        task_id: task.task_id,
        process_id: started.process_id,
      },
    }),
  );
  assert.equal(running.status, "RUNNING");

  const exited = await waitFor(async () => {
    const status = dataFrom(
      await client.callTool({
        name: "process.status",
        arguments: {
          task_id: task.task_id,
          process_id: started.process_id,
        },
      }),
    );
    return status.status === "EXITED" ? status : null;
  });
  assert.equal(exited.exit_code, 0);

  const output = dataFrom(
    await client.callTool({
      name: "process.output",
      arguments: {
        task_id: task.task_id,
        process_id: started.process_id,
        cursor: 0,
      },
    }),
  );
  assert.equal(output.stdout_chunk, "done\n");

  const cancelled = dataFrom(
    await client.callTool({
      name: "task.cancel",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(cancelled.status, "CANCELLED");

  const cleaned = dataFrom(
    await client.callTool({
      name: "task.cleanup",
      arguments: { task_id: task.task_id },
    }),
  );
  assert.equal(cleaned.workspace_cleaned, true);

  assert.equal(await git(repoDir, ["rev-parse", "HEAD"]), sourceHead);
  assert.equal(
    await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    "",
  );
});

test("v0.2-02: non-loopback CLI requires explicit allowed hosts", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["src/http.js"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTDOCK_HTTP_HOST: "0.0.0.0",
        AGENTDOCK_HTTP_PORT: "31999",
        AGENTDOCK_HTTP_ALLOWED_HOSTS: "",
      },
    },
  ).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
    error,
  }));

  assert.equal(typeof stdout, "string");
  assert.match(stderr, /AGENTDOCK_HTTP_ALLOWED_HOSTS is required/);
});
