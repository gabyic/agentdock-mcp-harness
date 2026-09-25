#!/usr/bin/env node
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  process.stderr.write("RELEASE_VERIFY_FAIL: " + message + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  let root = process.cwd();
  let tag =
    process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined;

  while (argv.length > 0) {
    const arg = argv.shift();
    if (arg === "--root") {
      const value = argv.shift();
      if (!value) fail("--root requires a path.");
      root = path.resolve(value);
      continue;
    }
    if (arg === "--tag") {
      const value = argv.shift();
      if (!value) fail("--tag requires a value.");
      tag = value;
      continue;
    }
    if (arg === "--no-tag") {
      tag = undefined;
      continue;
    }
    fail("unknown option: " + arg);
  }
  return { root, tag };
}

function validSemver(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  );
}

const { root, tag } = parseArgs(process.argv.slice(2));
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const versionPath = path.join(root, "src", "version.js");
const changelogPath = path.join(root, "CHANGELOG.md");

const [pkg, lock, changelog] = await Promise.all([
  readFile(packagePath, "utf8").then(JSON.parse),
  readFile(lockPath, "utf8").then(JSON.parse),
  readFile(changelogPath, "utf8"),
]);

const versionModule = await import(
  pathToFileURL(versionPath).href + "?verify=" + Date.now()
);
const version = pkg.version;

if (!validSemver(version)) {
  fail("package.json version is not valid SemVer: " + version);
}
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  fail(
    "package-lock version mismatch: package=" +
      version +
      " lock=" +
      lock.version +
      " root=" +
      lock.packages?.[""]?.version,
  );
}
if (versionModule.AGENTDOCK_VERSION !== version) {
  fail(
    "src/version.js mismatch: package=" +
      version +
      " source=" +
      versionModule.AGENTDOCK_VERSION,
  );
}
if (pkg.private !== true) {
  fail(
    "package.json must remain private=true until npm publishing is explicitly approved.",
  );
}
if (pkg.engines?.node !== ">=24") {
  fail("package.json engines.node must remain >=24 for v0.2.");
}
if (pkg.license !== "MIT") {
  fail("package.json license must be MIT.");
}
if (pkg.bin?.agentdock !== "src/cli.js") {
  fail("agentdock CLI bin metadata is missing or changed.");
}
if (pkg.bin?.["agentdock-mcp"] !== "src/index.js") {
  fail("agentdock-mcp bin metadata is missing or changed.");
}
if (pkg.bin?.["agentdock-supervisor"] !== "src/supervisor.js") {
  fail("agentdock-supervisor bin metadata is missing or changed.");
}

for (const relative of [
  "src/cli.js",
  "src/index.js",
  "scripts/install.sh",
  "scripts/upgrade.sh",
  "scripts/uninstall.sh",
  "scripts/build-release.sh",
  "scripts/smoke-release.sh",
  "scripts/release-gate.sh",
  "scripts/verify-systemd-unit.mjs",
]) {
  const target = path.join(root, relative);
  await access(target).catch(() =>
    fail("required release file missing: " + relative),
  );
  const info = await stat(target);
  if ((info.mode & 0o111) === 0) {
    fail("required executable is not executable: " + relative);
  }
}

const escapedVersion = version.replace(
  /[-/\\^$*+?.()|[\]{}]/g,
  "\\$&",
);
const releaseHeading = new RegExp(
  "^## \\[" +
    escapedVersion +
    "\\] - \\d{4}-\\d{2}-\\d{2}$",
  "m",
);
if (!releaseHeading.test(changelog)) {
  fail(
    "CHANGELOG.md must contain a dated release heading for " + version,
  );
}
if (!/^## \[Unreleased\]$/m.test(changelog)) {
  fail("CHANGELOG.md must retain an [Unreleased] section.");
}

if (tag !== undefined) {
  const expected = "v" + version;
  if (tag !== expected) {
    fail(
      "tag/version mismatch: expected " +
        expected +
        " but got " +
        tag,
    );
  }

  const releaseNotes = path.join(
    root,
    "docs",
    "releases",
    tag + ".md",
  );
  let notes;
  try {
    notes = await readFile(releaseNotes, "utf8");
  } catch {
    fail("release notes missing for tag: docs/releases/" + tag + ".md");
  }
  if (!notes.trim() || !notes.includes(tag)) {
    fail("release notes must be non-empty and mention " + tag);
  }
}

process.stdout.write(
  JSON.stringify(
    {
      status: "PASS",
      version,
      expected_tag: "v" + version,
      tag: tag ?? null,
      npm_publishable: false,
      node_engine: pkg.engines.node,
      license: pkg.license,
    },
    null,
    2,
  ) + "\n",
);
