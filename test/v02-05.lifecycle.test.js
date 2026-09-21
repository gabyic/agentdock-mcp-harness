import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
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

function cleanEnv(homeDir, extra = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined && !key.startsWith("AGENTDOCK_"),
      ),
    ),
    HOME: homeDir,
    npm_config_registry: "https://registry.npmjs.org",
    ...extra,
  };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function makeReleaseLikeSource(destination, version) {
  await mkdir(destination, { recursive: true });
  for (const entry of [
    "src",
    "scripts",
    "package.json",
    "package-lock.json",
    "config.example.json",
  ]) {
    await cp(
      path.join(projectRoot, entry),
      path.join(destination, entry),
      { recursive: true },
    );
  }

  const packagePath = path.join(destination, "package.json");
  const lockPath = path.join(destination, "package-lock.json");
  const versionPath = path.join(destination, "src", "version.js");

  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.version = version;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.version = version;
  lock.packages[""].version = version;
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");

  await writeFile(
    versionPath,
    'export const AGENTDOCK_VERSION = "' + version + '";\n',
  );

  for (const script of [
    "install.sh",
    "upgrade.sh",
    "uninstall.sh",
    "version-compare.mjs",
    "build-release.sh",
  ]) {
    const target = path.join(destination, "scripts", script);
    if (await exists(target)) {
      await (await import("node:fs/promises")).chmod(target, 0o755);
    }
  }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

test("v0.2-05: release-like install, versioned upgrade and default uninstall preserve durable data", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-05-life-"),
  );
  const home = path.join(root, "home");
  const sourceV5 = path.join(root, "source-v5");
  const sourceV6 = path.join(root, "source-v6");
  const installDir = path.join(home, ".local", "share", "agentdock-mcp-harness");
  const binDir = path.join(home, ".local", "bin");
  const stateDir = path.join(home, "durable-state");
  const configDir = path.join(home, ".config", "agentdock");
  const configPath = path.join(configDir, "config.json");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(home, { recursive: true });
  await makeReleaseLikeSource(sourceV5, "0.2.0-dev.5");
  await makeReleaseLikeSource(sourceV6, "0.2.0-dev.6");

  assert.equal(await exists(path.join(sourceV5, ".git")), false);

  const env = cleanEnv(home);
  const install = await run(
    path.join(sourceV5, "scripts", "install.sh"),
    [
      "--skip-tests",
      "--install-dir",
      installDir,
      "--bin-dir",
      binDir,
      "--state-dir",
      stateDir,
    ],
    { env },
  );
  assert.match(install.stdout, /Installed agentdock-mcp-harness 0\.2\.0-dev\.5/);

  const manifestPath = path.join(
    installDir,
    ".agentdock-install.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.version, "0.2.0-dev.5");
  assert.equal(manifest.install_dir, installDir);
  assert.equal(manifest.bin_dir, binDir);
  assert.equal(manifest.state_dir_at_install, stateDir);
  assert.equal(manifest.state_dir_explicit, true);
  assert.equal(await exists(path.join(installDir, "scripts", "upgrade.sh")), true);
  assert.equal(await exists(path.join(installDir, "scripts", "uninstall.sh")), true);

  const cli = path.join(binDir, "agentdock");
  const mcp = path.join(binDir, "agentdock-mcp");
  assert.equal((await stat(cli)).mode & 0o111 ? true : false, true);
  assert.equal((await stat(mcp)).mode & 0o111 ? true : false, true);

  const versionBefore = await run(cli, ["version"], { env });
  assert.equal(versionBefore.stdout.trim(), "0.2.0-dev.5");

  await writeFile(path.join(stateDir, "keep-me.txt"), "state\n");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      state: { dir: stateDir },
      transport: { mode: "stdio" },
    }),
  );

  const upgrade = await run(
    cli,
    [
      "upgrade",
      "--source",
      sourceV6,
      "--skip-tests",
    ],
    { env },
  );
  assert.match(upgrade.stdout, /Upgrade complete: 0\.2\.0-dev\.5 -> 0\.2\.0-dev\.6/);

  const upgradedManifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  );
  assert.equal(upgradedManifest.version, "0.2.0-dev.6");
  assert.equal(upgradedManifest.install_mode, "upgrade");
  assert.equal(await readFile(path.join(stateDir, "keep-me.txt"), "utf8"), "state\n");
  assert.equal(await exists(configPath), true);

  const versionAfter = await run(cli, ["version"], { env });
  assert.equal(versionAfter.stdout.trim(), "0.2.0-dev.6");

  let downgradeError;
  try {
    await run(
      cli,
      [
        "upgrade",
        "--source",
        sourceV5,
        "--skip-tests",
      ],
      { env },
    );
  } catch (error) {
    downgradeError = error;
  }
  assert.ok(downgradeError);
  assert.equal(downgradeError.code, 1);
  assert.match(downgradeError.stderr, /Refusing downgrade/);
  assert.equal(
    JSON.parse(await readFile(manifestPath, "utf8")).version,
    "0.2.0-dev.6",
  );

  const uninstall = await run(cli, ["uninstall"], { env });
  assert.match(uninstall.stdout, /Preserved state/);
  assert.match(uninstall.stdout, /Preserved config/);
  assert.equal(await exists(installDir), false);
  assert.equal(await exists(cli), false);
  assert.equal(await exists(mcp), false);
  assert.equal(await readFile(path.join(stateDir, "keep-me.txt"), "utf8"), "state\n");
  assert.equal(await exists(configPath), true);
});

test("v0.2-05: explicit uninstall can remove state and config, and unsafe state paths are refused", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-05-remove-"),
  );
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const installDir = path.join(home, ".local", "share", "agentdock-mcp-harness");
  const binDir = path.join(home, ".local", "bin");
  const stateDir = path.join(home, "state");
  const configPath = path.join(home, ".config", "agentdock", "config.json");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(home, { recursive: true });
  await makeReleaseLikeSource(source, "0.2.0-dev.5");
  const env = cleanEnv(home);

  await run(
    path.join(source, "scripts", "install.sh"),
    [
      "--skip-tests",
      "--install-dir",
      installDir,
      "--bin-dir",
      binDir,
      "--state-dir",
      stateDir,
    ],
    { env },
  );
  await writeFile(path.join(stateDir, "delete-me.txt"), "state\n");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      state: { dir: stateDir },
    }),
  );

  const cli = path.join(binDir, "agentdock");

  let unsafe;
  try {
    await run(
      cli,
      [
        "uninstall",
        "--remove-state",
        "--state-dir",
        "/",
      ],
      { env },
    );
  } catch (error) {
    unsafe = error;
  }
  assert.ok(unsafe);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /Refusing unsafe state removal path/);
  assert.equal(await exists(installDir), true);

  const removed = await run(
    cli,
    [
      "uninstall",
      "--remove-state",
      "--state-dir",
      stateDir,
      "--remove-config",
      "--config",
      configPath,
    ],
    { env },
  );
  assert.match(removed.stdout, /Removed state/);
  assert.match(removed.stdout, /Removed config/);
  assert.equal(await exists(installDir), false);
  assert.equal(await exists(stateDir), false);
  assert.equal(await exists(configPath), false);
});

test("v0.2-05: unmanaged source CLI refuses lifecycle mutation", async () => {
  let uninstallError;
  try {
    await run(
      process.execPath,
      ["src/cli.js", "uninstall"],
      { env: cleanEnv(os.homedir()) },
    );
  } catch (error) {
    uninstallError = error;
  }
  assert.ok(uninstallError);
  assert.equal(uninstallError.code, 1);
  assert.match(
    uninstallError.stderr,
    /Managed AgentDock install manifest not found or invalid/,
  );

  let upgradeError;
  try {
    await run(
      process.execPath,
      [
        "src/cli.js",
        "upgrade",
        "--source",
        projectRoot,
        "--skip-tests",
      ],
      { env: cleanEnv(os.homedir()) },
    );
  } catch (error) {
    upgradeError = error;
  }
  assert.ok(upgradeError);
  assert.equal(upgradeError.code, 1);
  assert.match(
    upgradeError.stderr,
    /Managed AgentDock install manifest not found or invalid/,
  );
});

test("v0.2-05: semantic version comparator orders prereleases deterministically", async () => {
  const script = path.join(
    projectRoot,
    "scripts",
    "version-compare.mjs",
  );
  const cases = [
    ["0.2.0-dev.5", "0.2.0-dev.4", "1"],
    ["0.2.0-dev.4", "0.2.0-dev.5", "-1"],
    ["0.2.0-dev.5", "0.2.0-dev.5", "0"],
    ["0.2.0", "0.2.0-dev.99", "1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", "-1"],
  ];
  for (const [a, b, expected] of cases) {
    const { stdout } = await run(
      process.execPath,
      [script, a, b],
    );
    assert.equal(stdout, expected);
  }
});
