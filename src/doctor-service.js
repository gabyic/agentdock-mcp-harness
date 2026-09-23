import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  rm,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadAgentDockConfig } from "./config.js";
import { AGENTDOCK_VERSION } from "./version.js";

const execFileAsync = promisify(execFile);
const STATUS_ORDER = { PASS: 0, WARN: 1, FAIL: 2 };

function check(id, status, summary, details = undefined) {
  return {
    id,
    status,
    summary,
    ...(details === undefined ? {} : { details }),
  };
}

function overallStatus(checks) {
  let result = "PASS";
  for (const item of checks) {
    if (STATUS_ORDER[item.status] > STATUS_ORDER[result]) {
      result = item.status;
    }
  }
  return result;
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

async function nodeCheck() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  return check(
    "node",
    Number.isInteger(major) && major >= 24 ? "PASS" : "FAIL",
    "Node.js " + process.version,
    {
      version,
      required_major: 24,
      executable: process.execPath,
    },
  );
}

async function gitCheck() {
  try {
    const { stdout } = await run("git", ["--version"]);
    const versionText = stdout.trim();
    return check("git", "PASS", versionText, {
      executable: "git",
    });
  } catch (error) {
    return check("git", "FAIL", "Git is unavailable.", {
      error: error?.code === "ENOENT" ? "command not found" : "git --version failed",
    });
  }
}

async function gitWorktreeCheck() {
  let root;
  try {
    root = await mkdtemp(path.join(os.tmpdir(), "agentdock-doctor-git-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    await mkdir(repo);

    await run("git", ["init", "-b", "main", repo]);
    await run("git", [
      "-C",
      repo,
      "-c",
      "user.name=AgentDock Doctor",
      "-c",
      "user.email=agentdock-doctor@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "doctor fixture",
    ]);
    await run("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "--detach",
      worktree,
      "HEAD",
    ]);
    const { stdout } = await run("git", [
      "-C",
      repo,
      "worktree",
      "list",
      "--porcelain",
    ]);

    if (!stdout.includes("worktree " + worktree)) {
      throw new Error("temporary worktree was not listed by Git");
    }

    await run("git", [
      "-C",
      repo,
      "worktree",
      "remove",
      "--force",
      worktree,
    ]);

    return check(
      "git_worktree",
      "PASS",
      "Git detached worktree create/list/remove succeeded.",
    );
  } catch (error) {
    return check(
      "git_worktree",
      "FAIL",
      "Git worktree capability check failed.",
      { error: error?.message ?? String(error) },
    );
  } finally {
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function stateDirectoryCheck(config) {
  const stateDir = config.state.dir;
  let probePath;
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    probePath = path.join(
      stateDir,
      ".agentdock-doctor-" +
        process.pid +
        "-" +
        Date.now() +
        ".tmp",
    );
    const handle = await open(probePath, "wx", 0o600);
    try {
      await handle.writeFile("agentdock-doctor\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await unlink(probePath);
    probePath = null;

    return check(
      "state_directory",
      "PASS",
      "State directory is writable.",
      { path: stateDir },
    );
  } catch (error) {
    return check(
      "state_directory",
      "FAIL",
      "State directory is not writable.",
      {
        path: stateDir,
        error: error?.code ?? error?.message ?? String(error),
      },
    );
  } finally {
    if (probePath) {
      await unlink(probePath).catch(() => {});
    }
  }
}

function transportCheck(config) {
  if (config.transport.mode === "stdio") {
    return check(
      "transport",
      "PASS",
      "Transport is stdio.",
      { mode: "stdio" },
    );
  }

  const http = config.transport.http;
  const loopback =
    http.host === "127.0.0.1" ||
    http.host === "localhost" ||
    http.host === "::1" ||
    http.host === "[::1]";

  return check(
    "transport",
    loopback ? "PASS" : "WARN",
    loopback
      ? "HTTP transport is bound to loopback."
      : "HTTP transport is configured beyond loopback; authenticated TLS ingress is recommended.",
    {
      mode: "http",
      host: http.host,
      port: http.port,
      path: http.path,
      health_path: http.health_path,
      allowed_hosts: [...http.allowed_hosts],
      allowed_origins: [...http.allowed_origins],
    },
  );
}

function policyCheck(config) {
  const count = config.policy.rules.length;
  if (count === 0) {
    return check(
      "policy",
      "WARN",
      "Policy is valid but has no explicit rules; unmatched operations use default allow.",
      { rule_count: 0 },
    );
  }

  return check(
    "policy",
    "PASS",
    "Policy configuration is valid.",
    { rule_count: count },
  );
}

function osUserCheck() {
  try {
    const user = os.userInfo();
    return check(
      "os_user",
      "PASS",
      "Running as OS user " + user.username + ".",
      {
        username: user.username,
        uid: user.uid,
        gid: user.gid,
        homedir: user.homedir,
      },
    );
  } catch (error) {
    return check(
      "os_user",
      "FAIL",
      "Could not resolve the current OS user.",
      { error: error?.message ?? String(error) },
    );
  }
}

async function sudoCheck() {
  try {
    await run("sudo", ["-n", "true"]);
    return check(
      "sudo",
      "PASS",
      "Passwordless sudo is available.",
      { optional: true },
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return check(
        "sudo",
        "WARN",
        "sudo is not installed; Core does not require it.",
        { optional: true },
      );
    }

    return check(
      "sudo",
      "WARN",
      "Passwordless sudo is unavailable; Core does not require it.",
      { optional: true },
    );
  }
}

function configCheck(result) {
  const { config, metadata } = result;
  return check(
    "config",
    "PASS",
    metadata.config_file_loaded
      ? "Configuration loaded and validated."
      : "Configuration validated using defaults/environment; no config file was loaded.",
    {
      schema_version: metadata.schema_version,
      config_path: metadata.config_path,
      config_file_loaded: metadata.config_file_loaded,
      env_overrides: metadata.env_overrides,
      state_dir: config.state.dir,
      transport_mode: config.transport.mode,
      policy_rule_count: config.policy.rules.length,
      matt_auto_routing: config.skills.matt_auto_routing,
      matt_router_skill: config.skills.router_skill,
    },
  );
}

function configFailureCheck(error, requestedPath) {
  return check(
    "config",
    "FAIL",
    "Configuration could not be loaded or validated.",
    {
      code: error?.code ?? "CONFIG_ERROR",
      message: error?.message ?? String(error),
      ...(requestedPath ? { requested_path: requestedPath } : {}),
    },
  );
}

export async function runDoctor({
  env = process.env,
  homeDir = os.homedir(),
  configPath,
} = {}) {
  const checks = [];
  checks.push(await nodeCheck());
  checks.push(await gitCheck());
  checks.push(await gitWorktreeCheck());
  checks.push(osUserCheck());
  checks.push(await sudoCheck());

  let configResult = null;
  try {
    configResult = loadAgentDockConfig({
      env,
      homeDir,
      ...(configPath === undefined ? {} : { configPath }),
    });
    checks.push(configCheck(configResult));
    checks.push(await stateDirectoryCheck(configResult.config));
    checks.push(transportCheck(configResult.config));
    checks.push(policyCheck(configResult.config));
  } catch (error) {
    checks.push(configFailureCheck(error, configPath));
  }

  return {
    doctor_version: 1,
    agentdock_version: AGENTDOCK_VERSION,
    timestamp: new Date().toISOString(),
    overall_status: overallStatus(checks),
    checks,
  };
}

export function formatDoctorReport(report) {
  const lines = [
    "AgentDock Doctor " + report.agentdock_version,
    "Overall: " + report.overall_status,
    "",
  ];

  for (const item of report.checks) {
    lines.push("[" + item.status + "] " + item.id + " — " + item.summary);
    if (item.details) {
      for (const [key, value] of Object.entries(item.details)) {
        lines.push(
          "    " +
            key +
            ": " +
            (typeof value === "string" ? value : JSON.stringify(value)),
        );
      }
    }
  }

  return lines.join("\n") + "\n";
}
