import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgentDockError } from "../src/errors.js";
import { loadAgentDockConfig } from "../src/config.js";
import { createAgentDockRuntime } from "../src/server.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

async function waitForHttp(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for HTTP server: " + url);
}

test("v0.2-03: config precedence is defaults < file < env < programmatic overrides", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-03-config-"));
  const configPath = path.join(tempRoot, "config.json");
  const envStateDir = path.join(tempRoot, "state-from-env");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        state: {
          dir: "~/state-from-file",
          persisted_process_output_bytes: 2048,
        },
        audit: {
          max_entries_per_task: 4,
        },
        policy: {
          rules: [
            {
              id: "file-rule",
              effect: "deny",
              tool: "process.start",
            },
          ],
        },
        transport: {
          mode: "http",
          http: {
            host: "127.0.0.1",
            port: 3200,
            path: "/from-file",
            health_path: "/ready",
            allowed_hosts: ["file.local"],
          },
        },
      },
      null,
      2,
    ),
  );

  const envRule = [
    {
      id: "env-rule",
      effect: "ask",
      tool: "process.start",
      shell_regex: "^printf",
      approval_scope: "env-scope",
    },
  ];

  const { config, metadata } = loadAgentDockConfig({
    homeDir: tempRoot,
    configPath,
    env: {
      AGENTDOCK_STATE_DIR: envStateDir,
      AGENTDOCK_HTTP_PORT: "3300",
      AGENTDOCK_AUDIT_MAX_ENTRIES: "3",
      AGENTDOCK_POLICY_JSON: JSON.stringify(envRule),
    },
    overrides: {
      audit: {
        max_entries_per_task: 2,
      },
      transport: {
        http: {
          port: 3400,
        },
      },
    },
  });

  assert.equal(config.version, 1);
  assert.equal(config.state.dir, envStateDir);
  assert.equal(config.state.persisted_process_output_bytes, 2048);
  assert.equal(config.audit.max_entries_per_task, 2);
  assert.deepEqual(config.policy.rules, envRule);
  assert.equal(config.transport.mode, "http");
  assert.equal(config.transport.http.port, 3400);
  assert.equal(config.transport.http.path, "/from-file");
  assert.equal(config.skills.matt_auto_routing, false);
  assert.deepEqual(config.transport.http.allowed_hosts, ["file.local"]);
  assert.deepEqual(config.transport.http.allowed_origins, ["file.local"]);

  assert.equal(metadata.config_path, configPath);
  assert.equal(metadata.config_file_loaded, true);
  assert.deepEqual(metadata.env_overrides, [
    "AGENTDOCK_AUDIT_MAX_ENTRIES",
    "AGENTDOCK_HTTP_PORT",
    "AGENTDOCK_POLICY_JSON",
    "AGENTDOCK_STATE_DIR",
  ]);
});

test("v0.2-03: default config discovery and explicit missing config semantics are deterministic", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-03-home-"));
  const defaultConfigPath = path.join(
    tempRoot,
    ".config",
    "agentdock",
    "config.json",
  );

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const absent = loadAgentDockConfig({
    homeDir: tempRoot,
    env: {},
  });
  assert.equal(absent.metadata.config_file_loaded, false);
  assert.equal(
    absent.config.state.dir,
    path.join(tempRoot, ".local", "state", "agentdock"),
  );
  assert.equal(absent.config.transport.mode, "stdio");

  await mkdir(path.dirname(defaultConfigPath), { recursive: true });
  await writeFile(
    defaultConfigPath,
    JSON.stringify({
      version: 1,
      state: {
        dir: "~/configured-state",
      },
      transport: {
        mode: "http",
        http: {
          host: "127.0.0.1",
          port: 3456,
        },
      },
    }),
  );

  const discovered = loadAgentDockConfig({
    homeDir: tempRoot,
    env: {},
  });
  assert.equal(discovered.metadata.config_file_loaded, true);
  assert.equal(
    discovered.config.state.dir,
    path.join(tempRoot, "configured-state"),
  );
  assert.equal(discovered.config.transport.mode, "http");
  assert.equal(discovered.config.transport.http.port, 3456);
  assert.equal(
    discovered.config.execution.supervisor_socket,
    path.join(tempRoot, "configured-state", "run-supervisor.sock"),
  );

  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        env: {},
        configPath: path.join(tempRoot, "missing.json"),
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "CONFIG_NOT_FOUND",
  );
});

test("v0.2-03: invalid or unsafe config fails closed", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-03-invalid-"));
  const badConfigPath = path.join(tempRoot, "bad.json");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(
    badConfigPath,
    JSON.stringify({
      version: 1,
      state: {
        dir: path.join(tempRoot, "state"),
      },
      unknown_key: true,
    }),
  );

  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        env: {},
        configPath: badConfigPath,
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "INVALID_CONFIG" &&
      error.details?.issues?.some(
        (issue) => issue.message.includes("Unrecognized key"),
      ),
  );

  await writeFile(
    badConfigPath,
    JSON.stringify({
      state: {
        dir: path.join(tempRoot, "state"),
      },
    }),
  );
  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        env: {},
        configPath: badConfigPath,
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "INVALID_CONFIG" &&
      /schema version/.test(error.message),
  );

  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        configPath: null,
        env: {
          AGENTDOCK_TRANSPORT: "http",
          AGENTDOCK_HTTP_HOST: "0.0.0.0",
        },
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "INVALID_CONFIG" &&
      /AGENTDOCK_HTTP_ALLOWED_HOSTS/.test(error.message),
  );

  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        configPath: null,
        env: {
          AGENTDOCK_HTTP_PORT: "not-a-number",
        },
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "INVALID_CONFIG",
  );

  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        configPath: null,
        env: {
          AGENTDOCK_POLICY_JSON: JSON.stringify([
            {
              id: "bad-regex",
              effect: "ask",
              tool: "process.start",
              shell_regex: "[",
            },
          ]),
        },
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "INVALID_CONFIG",
  );
});

test("v0.2-03: runtime applies policy, persisted-output and audit-retention config", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-03-runtime-"));
  const stateDir = path.join(tempRoot, "state");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const { config } = loadAgentDockConfig({
    homeDir: tempRoot,
    configPath: null,
    env: {},
    overrides: {
      state: {
        dir: stateDir,
        persisted_process_output_bytes: 1024,
      },
      audit: {
        max_entries_per_task: 3,
      },
      policy: {
        rules: [
          {
            id: "configured-ask",
            effect: "ask",
            tool: "process.start",
            shell_regex: "^echo",
            approval_scope: "configured-scope",
          },
        ],
      },
    },
  });

  const runtime = createAgentDockRuntime({ config });

  assert.equal(runtime.config, config);
  assert.equal(runtime.stateStore.stateDir, stateDir);
  assert.equal(runtime.stateStore.maxPersistedOutputBytes, 1024);
  assert.deepEqual(
    runtime.policyService.evaluate({
      tool: "process.start",
      shell: "echo hello",
    }),
    {
      rule_id: "configured-ask",
      effect: "ask",
      approval_scope: "configured-scope",
    },
  );

  const largeOutput = "x".repeat(2048);
  runtime.stateStore.saveProcess({
    process_id: "proc_config_test",
    task_id: "task_config_test",
    pid: null,
    status: "EXITED",
    mode: "argv",
    argv: ["echo"],
    shell: undefined,
    cwd: tempRoot,
    env: { API_KEY: "do-not-persist" },
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: 0,
    signal: null,
    error: null,
    cancel_requested: false,
    output: [{ cursor: 0, stream: "stdout", text: largeOutput }],
    next_output_cursor: 1,
    output_total_bytes: Buffer.byteLength(largeOutput),
  });

  const persisted = runtime.stateStore.loadProcess("proc_config_test");
  assert.equal(persisted.persisted_output_bytes, 1024);
  assert.equal(persisted.persisted_output_truncated, true);
  assert.equal(
    Buffer.byteLength(persisted.output[0].text, "utf8"),
    1024,
  );
  assert.equal(persisted.env.API_KEY, "[REDACTED]");

  for (let index = 1; index <= 5; index += 1) {
    runtime.auditService.append("task_config_test", {
      event: "CONFIG_EVENT_" + index,
    });
  }

  const audit = runtime.auditService.get("task_config_test", {
    afterSequence: 0,
    limit: 100,
  });
  assert.deepEqual(
    audit.entries.map((entry) => entry.sequence),
    [3, 4, 5],
  );
  assert.equal(audit.retained_from_sequence, 3);
  assert.equal(audit.truncated_before_sequence, true);
  assert.equal(audit.next_sequence, 6);

  const storedAudit = runtime.stateStore.loadAudit("task_config_test");
  assert.equal(storedAudit.entries.length, 3);
  assert.equal(storedAudit.next_sequence, 6);
  runtime.stateStore.close?.();
});

test("v0.2-03: main entrypoint follows transport.mode from config file", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-03-entry-"));
  const configPath = path.join(tempRoot, "config.json");
  const stateDir = path.join(tempRoot, "state");
  const port = await getFreePort();

  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !key.startsWith("AGENTDOCK_"),
    ),
  );
  childEnv.AGENTDOCK_CONFIG = configPath;

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      state: {
        dir: stateDir,
      },
      transport: {
        mode: "http",
        http: {
          host: "127.0.0.1",
          port,
        },
      },
    }),
  );

  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "src", "index.js")],
    {
      cwd: projectRoot,
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const response = await waitForHttp(
    "http://127.0.0.1:" + port + "/healthz",
  );
  const health = await response.json();
  assert.equal(health.status, "ok");
  assert.equal(health.transport, "streamable-http");
  assert.equal(health.mode, "stateless");
  assert.equal(health.state_backend, "sqlite");
  assert.equal(health.supervisor?.ready, true);
  assert.equal(health.supervisor?.mode, "owner");
  assert.match(health.supervisor?.instance_id, /^runtime_[0-9a-f-]{36}$/);
  assert.match(stderr, /AgentDock Streamable HTTP listening/);

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(exited, true);
});


test("v0.3: Matt auto-routing config is explicit, defaults off, and accepts boolean env values", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v03-auto-matt-"));
  const stateDir = path.join(tempRoot, "state");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const disabled = loadAgentDockConfig({
    homeDir: tempRoot,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
    },
  });
  assert.equal(disabled.config.skills.matt_auto_routing, false);

  const enabled = loadAgentDockConfig({
    homeDir: tempRoot,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_MATT_AUTO_ROUTING: "true",
    },
  });
  assert.equal(enabled.config.skills.matt_auto_routing, true);
  assert.equal(
    enabled.metadata.env_overrides.includes("AGENTDOCK_MATT_AUTO_ROUTING"),
    true,
  );

  assert.throws(
    () =>
      loadAgentDockConfig({
        homeDir: tempRoot,
        configPath: null,
        env: {
          AGENTDOCK_STATE_DIR: stateDir,
          AGENTDOCK_MATT_AUTO_ROUTING: "maybe",
        },
      }),
    (error) =>
      error instanceof AgentDockError &&
      error.code === "INVALID_CONFIG" &&
      /AGENTDOCK_MATT_AUTO_ROUTING/.test(error.message),
  );
});
