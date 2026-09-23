import { execFileSync, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { AgentDockError } from "./errors.js";

export const GUARDED_EXECUTION_MODES = Object.freeze(["off", "observe", "enforce"]);
export const MIN_SUPPORTED_BWRAP_VERSION = "0.12.0";

const SAFE_SANDBOX_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
];

function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function probeSandboxRuntime({
  binary = "/usr/bin/bwrap",
  minVersion = MIN_SUPPORTED_BWRAP_VERSION,
} = {}) {
  try {
    const stdout = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const version = parseVersion(stdout)?.join(".") ?? null;
    const comparison = version ? compareVersions(version, minVersion) : null;
    return {
      binary,
      kind: "bubblewrap",
      installed: true,
      version,
      min_supported_version: minVersion,
      ready: comparison !== null && comparison >= 0,
      reason:
        comparison === null
          ? "sandbox version could not be parsed"
          : comparison < 0
            ? "sandbox runtime is below the minimum supported version"
            : null,
    };
  } catch (error) {
    return {
      binary,
      kind: "bubblewrap",
      installed: false,
      version: null,
      min_supported_version: minVersion,
      ready: false,
      reason:
        error?.code === "ENOENT"
          ? "sandbox runtime is not installed"
          : "sandbox runtime probe failed",
    };
  }
}

function hiddenMountArgs(paths) {
  const args = [];
  for (const candidate of paths) {
    try {
      const info = lstatSync(candidate);
      if (info.isDirectory()) {
        args.push("--tmpfs", candidate);
      } else {
        args.push("--ro-bind", "/dev/null", candidate);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return args;
}

function sandboxEnvironmentArgs(explicitEnv = {}) {
  const values = {};
  for (const key of SAFE_SANDBOX_ENV_KEYS) {
    if (process.env[key] !== undefined) values[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(explicitEnv ?? {})) {
    values[key] = String(value);
  }
  values.HOME = "/tmp/agentdock-home";

  const args = ["--clearenv"];
  for (const [key, value] of Object.entries(values)) {
    args.push("--setenv", key, value);
  }
  return args;
}

export class ExecutionService {
  #mode;
  #sandboxBinary;
  #network;
  #hiddenPaths;

  constructor({
    mode = "off",
    sandboxBinary = "/usr/bin/bwrap",
    network = "deny",
    hiddenPaths = [],
  } = {}) {
    if (!GUARDED_EXECUTION_MODES.includes(mode)) {
      throw new TypeError(
        "guarded execution mode must be one of: " +
          GUARDED_EXECUTION_MODES.join(", "),
      );
    }
    if (!["deny", "allow"].includes(network)) {
      throw new TypeError("sandbox network must be deny or allow.");
    }
    this.#mode = mode;
    this.#sandboxBinary = sandboxBinary;
    this.#network = network;
    this.#hiddenPaths = [...new Set(hiddenPaths.map((value) => String(value)))];
  }

  get mode() {
    return this.#mode;
  }

  sandboxStatus() {
    return probeSandboxRuntime({ binary: this.#sandboxBinary });
  }

  plan({ scope, cwd }) {
    const lane = scope === "WORKSPACE" ? "WORKSPACE" : "HOST";
    const sandbox = this.sandboxStatus();

    let decision = "legacy";
    if (this.#mode === "observe") {
      decision = lane === "WORKSPACE" ? "would_sandbox" : "would_confirm";
    } else if (this.#mode === "enforce") {
      if (lane === "WORKSPACE") {
        if (!sandbox.ready) {
          throw new AgentDockError(
            "GUARDED_EXECUTION_SANDBOX_UNSAFE",
            "Guarded Execution enforce mode requires a supported sandbox runtime.",
            { sandbox },
          );
        }
        decision = "sandbox";
      } else {
        decision = "human_confirmation";
      }
    }

    return {
      guarded_mode: this.#mode,
      lane,
      decision,
      cwd,
      network: this.#network,
      hidden_paths: [...this.#hiddenPaths],
      sandbox,
    };
  }

  #spawnLegacy({ cwd, argv, shell, env }) {
    const hasArgv = Array.isArray(argv);
    const command = hasArgv ? argv[0] : shell;
    const args = hasArgv ? argv.slice(1) : [];
    return spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: !hasArgv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  #spawnSandbox({ cwd, workspaceRoot, argv, shell, env }) {
    if (!workspaceRoot) {
      throw new AgentDockError(
        "GUARDED_EXECUTION_WORKSPACE_REQUIRED",
        "Sandboxed execution requires a Task workspace root.",
      );
    }

    const args = [
      "--ro-bind", "/", "/",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--bind", workspaceRoot, workspaceRoot,
      ...hiddenMountArgs(this.#hiddenPaths),
      "--unshare-user",
      "--unshare-pid",
      "--cap-drop", "ALL",
      "--die-with-parent",
      "--new-session",
      ...sandboxEnvironmentArgs(env),
      "--dir", "/tmp/agentdock-home",
      "--chdir", cwd,
    ];
    if (this.#network === "deny") {
      args.push("--unshare-net");
    }

    if (Array.isArray(argv)) {
      args.push("--", ...argv);
    } else {
      args.push("--", "/bin/sh", "-c", shell);
    }

    return spawn(this.#sandboxBinary, args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  launch({
    scope,
    cwd,
    workspaceRoot,
    argv,
    shell,
    env,
    hostAuthorized = false,
  }) {
    const plan = this.plan({ scope, cwd });

    if (this.#mode !== "enforce") {
      return {
        child: this.#spawnLegacy({ cwd, argv, shell, env }),
        plan,
      };
    }

    if (plan.lane === "WORKSPACE") {
      return {
        child: this.#spawnSandbox({
          cwd,
          workspaceRoot,
          argv,
          shell,
          env,
        }),
        plan,
      };
    }

    if (!hostAuthorized) {
      throw new AgentDockError(
        "GUARDED_EXECUTION_HOST_CONFIRMATION_REQUIRED",
        "Host execution requires explicit confirmation in enforce mode.",
        { plan },
      );
    }

    return {
      child: this.#spawnLegacy({ cwd, argv, shell, env }),
      plan,
    };
  }
}
