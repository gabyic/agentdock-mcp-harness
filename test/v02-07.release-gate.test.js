import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
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
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

test("v0.2-07: release metadata verifier accepts the RC and its exact tag", async () => {
  const { stdout, stderr } = await run(
    process.execPath,
    [
      "scripts/verify-release.mjs",
      "--tag",
      "v0.2.0-rc.1",
    ],
  );
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "PASS");
  assert.equal(result.version, "0.2.0-rc.1");
  assert.equal(result.expected_tag, "v0.2.0-rc.1");
  assert.equal(result.tag, "v0.2.0-rc.1");
  assert.equal(result.npm_publishable, false);
  assert.equal(result.node_engine, ">=24");
  assert.equal(result.license, "MIT");
});

test("v0.2-07: release verifier fails closed on tag mismatch", async () => {
  let caught;
  try {
    await run(
      process.execPath,
      [
        "scripts/verify-release.mjs",
        "--tag",
        "v0.2.0",
      ],
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(caught.code, 1);
  assert.match(caught.stderr, /tag\/version mismatch/);
  assert.match(caught.stderr, /v0\.2\.0-rc\.1/);
});

test("v0.2-07: release verifier detects package-lock version drift", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-v02-07-verify-"),
  );

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const entry of [
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
    "src",
    "scripts",
    "docs",
  ]) {
    await cp(
      path.join(projectRoot, entry),
      path.join(root, entry),
      { recursive: true },
    );
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
    await chmod(path.join(root, relative), 0o755);
  }

  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.version = "0.2.0-rc.999";
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");

  let caught;
  try {
    await run(
      process.execPath,
      [
        "scripts/verify-release.mjs",
        "--root",
        root,
        "--tag",
        "v0.2.0-rc.1",
      ],
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(caught.code, 1);
  assert.match(caught.stderr, /package-lock version mismatch/);
});

test("v0.2-07: tag workflow is gated and publishes GitHub assets as prerelease", async () => {
  const workflow = await readFile(
    path.join(
      projectRoot,
      ".github",
      "workflows",
      "release.yml",
    ),
    "utf8",
  );

  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /contents: write/);
  assert.match(
    workflow,
    /\.\/scripts\/release-gate\.sh "\$GITHUB_REF_NAME"/,
  );
  assert.match(workflow, /docs\/releases\/\$\{GITHUB_REF_NAME\}\.md/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--prerelease/);

  const notes = await readFile(
    path.join(
      projectRoot,
      "docs",
      "releases",
      "v0.2.0-rc.1.md",
    ),
    "utf8",
  );
  assert.match(notes, /v0\.2\.0-rc\.1/);
  assert.match(notes, /npm publication remains disabled/i);
  assert.match(notes, /Stable v0\.2\.0 promotion/);
});
