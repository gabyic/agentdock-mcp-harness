import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  formatDoctorReport,
  runDoctor,
} from "../src/doctor-service.js";
import { AGENTDOCK_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

test("v0.2-04: doctor reports deterministic core diagnostics without requiring sudo", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-04-doctor-"),
  );
  const stateDir = path.join(tempRoot, "state");

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const secret = "PASSWORD=DOCTOR_MUST_NOT_PRINT_THIS";
  const report = await runDoctor({
    homeDir: tempRoot,
    configPath: null,
    env: cleanEnv({
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_POLICY_JSON: JSON.stringify([
        {
          id: "doctor-safe-rule",
          effect: "ask",
          tool: "process.start",
          approval_scope: secret,
        },
      ]),
    }),
  });

  assert.notEqual(report.overall_status, "FAIL");
  assert.equal(report.agentdock_version, AGENTDOCK_VERSION);

  const checks = new Map(
    report.checks.map((entry) => [entry.id, entry]),
  );
  for (const id of [
    "node",
    "git",
    "git_worktree",
    "os_user",
    "sudo",
    "config",
    "state_directory",
    "transport",
    "policy",
  ]) {
    assert.equal(checks.has(id), true, "missing doctor check " + id);
  }

  assert.equal(checks.get("node").status, "PASS");
  assert.equal(checks.get("git").status, "PASS");
  assert.equal(checks.get("git_worktree").status, "PASS");
  assert.equal(checks.get("config").status, "PASS");
  assert.equal(checks.get("state_directory").status, "PASS");
  assert.equal(checks.get("transport").details.mode, "stdio");
  assert.equal(checks.get("policy").details.rule_count, 1);
  assert.equal(["PASS", "WARN"].includes(checks.get("sudo").status), true);

  const serialized = JSON.stringify(report);
  const text = formatDoctorReport(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("AgentDock Doctor " + AGENTDOCK_VERSION), true);
  assert.match(text, /\[PASS\] git_worktree/);
});

test("v0.2-04: doctor CLI emits parseable JSON and exits zero for warnings", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-04-cli-"),
  );
  const configPath = path.join(tempRoot, "config.json");
  const stateDir = path.join(tempRoot, "state");
  const secret = "TOKEN=DOCTOR_JSON_SECRET";

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      state: {
        dir: stateDir,
      },
      policy: {
        rules: [
          {
            id: "safe-rule",
            effect: "allow",
            tool: "*",
            approval_scope: secret,
          },
        ],
      },
      transport: {
        mode: "stdio",
      },
    }),
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["src/cli.js", "doctor", "--json", "--config", configPath],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: cleanEnv(),
    },
  );

  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.notEqual(report.overall_status, "FAIL");
  assert.equal(report.agentdock_version, AGENTDOCK_VERSION);
  assert.equal(stdout.includes(secret), false);

  const configCheck = report.checks.find(
    (entry) => entry.id === "config",
  );
  assert.equal(configCheck.details.config_path, configPath);
  assert.equal(configCheck.details.config_file_loaded, true);
  assert.equal(configCheck.details.policy_rule_count, 1);
});

test("v0.2-04: invalid config produces a FAIL report and exit code 1 without leaking config contents", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-04-fail-"),
  );
  const configPath = path.join(tempRoot, "bad.json");
  const secret = "SECRET_VALUE_SHOULD_NOT_LEAK";

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      state: {
        dir: path.join(tempRoot, "state"),
      },
      unexpected_secret_field: secret,
    }),
  );

  let caught;
  try {
    await execFileAsync(
      process.execPath,
      ["src/cli.js", "doctor", "--json", "--config", configPath],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: cleanEnv(),
      },
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "doctor should exit non-zero on FAIL");
  assert.equal(caught.code, 1);
  assert.equal(caught.stderr, "");

  const report = JSON.parse(caught.stdout);
  assert.equal(report.overall_status, "FAIL");
  assert.equal(caught.stdout.includes(secret), false);

  const configCheck = report.checks.find(
    (entry) => entry.id === "config",
  );
  assert.equal(configCheck.status, "FAIL");
  assert.equal(configCheck.details.code, "INVALID_CONFIG");
});

test("v0.2-04: CLI help and unknown command behavior are explicit", async () => {
  const help = await execFileAsync(
    process.execPath,
    ["src/cli.js", "--help"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: cleanEnv(),
    },
  );
  assert.match(help.stdout, /agentdock doctor \[--json\] \[--config PATH\]/);

  let caught;
  try {
    await execFileAsync(
      process.execPath,
      ["src/cli.js", "unknown"],
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
  assert.equal(caught.code, 2);
  assert.match(caught.stderr, /Unknown command: unknown/);
});
