import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function currentInstallRoot() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
}

export function readInstallManifest(installRoot = currentInstallRoot()) {
  const manifestPath = path.join(
    installRoot,
    ".agentdock-install.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const wrapped = new Error(
      "Managed AgentDock install manifest not found or invalid: " +
        manifestPath,
    );
    wrapped.code = "UNMANAGED_INSTALL";
    throw wrapped;
  }

  if (
    manifest.schema_version !== 1 ||
    manifest.package_name !== "agentdock-mcp-harness"
  ) {
    const error = new Error(
      "Unsupported AgentDock install manifest: " + manifestPath,
    );
    error.code = "UNSUPPORTED_INSTALL_MANIFEST";
    throw error;
  }
  return { manifest, manifestPath, installRoot };
}

function runScript(scriptPath, args, env) {
  const result = spawnSync(scriptPath, args, {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

export function runUpgradeCommand({
  sourceDir,
  args = [],
  installRoot = currentInstallRoot(),
  env = process.env,
} = {}) {
  if (!sourceDir) {
    const error = new Error(
      "upgrade requires --source PATH to a new checkout or extracted release.",
    );
    error.code = "UPGRADE_SOURCE_REQUIRED";
    throw error;
  }

  const { manifest } = readInstallManifest(installRoot);
  const source = path.resolve(sourceDir);
  const scriptPath = path.join(source, "scripts", "upgrade.sh");

  return runScript(
    scriptPath,
    ["--source", source, ...args],
    {
      ...env,
      AGENTDOCK_INSTALL_DIR: installRoot,
      AGENTDOCK_BIN_DIR: manifest.bin_dir,
    },
  );
}

export function runUninstallCommand({
  args = [],
  installRoot = currentInstallRoot(),
  env = process.env,
} = {}) {
  const { manifest } = readInstallManifest(installRoot);
  const scriptPath = path.join(
    installRoot,
    "scripts",
    "uninstall.sh",
  );

  return runScript(scriptPath, args, {
    ...env,
    AGENTDOCK_INSTALL_DIR: installRoot,
    AGENTDOCK_BIN_DIR: manifest.bin_dir,
  });
}
