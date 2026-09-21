import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

test("v0.2-05: release artifacts are reproducible and install without .git", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-05-release-"),
  );
  const repo = path.join(root, "repo");
  const out1 = path.join(root, "out1");
  const out2 = path.join(root, "out2");
  const extract = path.join(root, "extract");
  const home = path.join(root, "home");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await cp(projectRoot, repo, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(projectRoot, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return ![".git", "node_modules", "dist", "build"].includes(first);
    },
  });

  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.name", "AgentDock Release Test"]);
  await run(
    "git",
    ["-C", repo, "config", "user.email", "agentdock-release@example.invalid"],
  );
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, "commit", "-m", "release fixture"]);

  const buildScript = path.join(repo, "scripts", "build-release.sh");
  const first = await run(buildScript, [out1], { cwd: repo });
  const second = await run(buildScript, [out2], { cwd: repo });
  assert.match(first.stdout, /ARTIFACT=/);
  assert.match(second.stdout, /ARTIFACT=/);

  const name = "agentdock-mcp-harness-v0.2.0-dev.6.tar.gz";
  const tgz1 = path.join(out1, name);
  const tgz2 = path.join(out2, name);
  const sha1 = (
    await run("sha256sum", [tgz1])
  ).stdout.split(/\s+/)[0];
  const sha2 = (
    await run("sha256sum", [tgz2])
  ).stdout.split(/\s+/)[0];
  assert.equal(sha1, sha2);

  const checksum = await readFile(tgz1 + ".sha256", "utf8");
  assert.equal(checksum.trim(), sha1 + "  " + name);
  await run("sha256sum", ["-c", name + ".sha256"], { cwd: out1 });

  const listing = (await run("tar", ["-tzf", tgz1])).stdout;
  const prefix = "agentdock-mcp-harness-0.2.0-dev.6/";
  for (const expected of [
    prefix + "package.json",
    prefix + "scripts/install.sh",
    prefix + "scripts/upgrade.sh",
    prefix + "scripts/uninstall.sh",
    prefix + "src/cli.js",
  ]) {
    assert.equal(listing.includes(expected + "\n"), true, expected);
  }

  await run("tar", ["-xzf", tgz1, "-C", extract], {
    cwd: root,
  }).catch(async (error) => {
    // tar requires target directory to exist.
    await (await import("node:fs/promises")).mkdir(extract, { recursive: true });
    return run("tar", ["-xzf", tgz1, "-C", extract], { cwd: root });
  });

  const extracted = path.join(
    extract,
    "agentdock-mcp-harness-0.2.0-dev.6",
  );
  assert.equal(
    await run("sh", ["-c", "test ! -e .git"], { cwd: extracted })
      .then(() => true),
    true,
  );

  const installDir = path.join(home, ".local", "share", "agentdock-mcp-harness");
  const binDir = path.join(home, ".local", "bin");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined && !key.startsWith("AGENTDOCK_"),
      ),
    ),
    HOME: home,
    npm_config_registry: "https://registry.npmjs.org",
  };

  await run(
    path.join(extracted, "scripts", "install.sh"),
    [
      "--skip-tests",
      "--install-dir",
      installDir,
      "--bin-dir",
      binDir,
    ],
    { cwd: extracted, env },
  );

  const installedUnit = path.join(
    installDir,
    "deploy",
    "systemd",
    "agentdock-http.service",
  );
  assert.match(
    await readFile(installedUnit, "utf8"),
    /^Restart=always$/m,
  );
  const verifiedUnit = await run(
    process.execPath,
    [
      path.join(
        installDir,
        "scripts",
        "verify-systemd-unit.mjs",
      ),
      installedUnit,
    ],
    { env },
  );
  assert.equal(
    verifiedUnit.stdout.trim(),
    "SYSTEMD_UNIT_CONTRACT=PASS",
  );

  const version = await run(
    path.join(binDir, "agentdock"),
    ["version"],
    { env },
  );
  assert.equal(version.stdout.trim(), "0.2.0-dev.6");

  const doctor = await run(
    path.join(binDir, "agentdock"),
    ["doctor", "--json"],
    { env },
  );
  const report = JSON.parse(doctor.stdout);
  assert.notEqual(report.overall_status, "FAIL");

  await writeFile(path.join(repo, "DIRTY"), "dirty\n");
  let dirtyError;
  try {
    await run(buildScript, [path.join(root, "out3")], {
      cwd: repo,
    });
  } catch (error) {
    dirtyError = error;
  }
  assert.ok(dirtyError);
  assert.match(dirtyError.stderr, /dirty worktree/);
});
