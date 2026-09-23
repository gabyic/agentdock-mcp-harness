import { execFileSync, spawn } from "node:child_process";
import { AgentDockError } from "./errors.js";

export const GUARDED_EXECUTION_MODES = Object.freeze(["off", "observe", "enforce"]);
export const MIN_SUPPORTED_BWRAP_VERSION = "0.12.0";

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
      reason: error?.code === "ENOENT"
        ? "sandbox runtime is not installed"
        : "sandbox runtime probe failed",
    };
  }
}

export class ExecutionService {
  #mode;
  #sandboxBinary;

  constructor({
    mode = "off",
    sandboxBinary = "/usr/bin/bwrap",
  } = {}) {
    if (!GUARDED_EXECUTION_MODES.includes(mode)) {
      throw new TypeError(
        "guarded execution mode must be one of: " +
          GUARDED_EXECUTION_MODES.join(", "),
      );
    }
    this.#mode = mode;
    this.#sandboxBinary = sandboxBinary;
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
      sandbox,
    };
  }

  launch({ scope, cwd, argv, shell, env }) {
    const plan = this.plan({ scope, cwd });
    if (this.#mode === "enforce") {
      throw new AgentDockError(
        "GUARDED_EXECUTION_ENFORCEMENT_PENDING",
        "Guarded Execution enforcement adapters are not enabled in this slice.",
        { plan },
      );
    }

    const hasArgv = Array.isArray(argv);
    const command = hasArgv ? argv[0] : shell;
    const args = hasArgv ? argv.slice(1) : [];
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: !hasArgv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, plan };
  }
}
