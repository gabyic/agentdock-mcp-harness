import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}

function cleanEnv(extra = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    ...extra,
  };
}

function dataFrom(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text");
  return JSON.parse(text);
}

async function removeLinkedWorktrees(repoDir) {
  try {
    const worktrees = await git(repoDir, ["worktree", "list", "--porcelain"]);
    for (const block of worktrees.split("\n\n")) {
      const line = block.split("\n").find((entry) => entry.startsWith("worktree "));
      const worktree = line?.slice("worktree ".length);
      if (worktree && path.resolve(worktree) !== path.resolve(repoDir)) {
        await git(repoDir, ["worktree", "remove", "--force", worktree]);
      }
    }
  } catch {
    // The surrounding temp directory cleanup is best-effort fallback.
  }
}

test("Ticket 02: read/search/patch/write/diff stay isolated in Task worktree", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentdock-ticket02-"),
  );
  const repoDir = path.join(tempRoot, "source-repo");
  const stateDir = path.join(tempRoot, "agentdock-state");
  const srcDir = path.join(repoDir, "src");

  await mkdir(srcDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);

  await writeFile(
    path.join(srcDir, "app.js"),
    'export function greet(name) {\n  return "Hello " + name;\n}\n',
    "utf8",
  );
  await writeFile(
    path.join(srcDir, "stale.js"),
    'export const value = "original";\n',
    "utf8",
  );
  await writeFile(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
  const outsideFile = path.join(tempRoot, "outside-secret.txt");
  await writeFile(outsideFile, "outside secret\n", "utf8");
  await symlink(outsideFile, path.join(srcDir, "escape-link"));
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);

  const sourceHeadBefore = await git(repoDir, ["rev-parse", "HEAD"]);

  // Dirty source changes must stay outside the Task.
  await writeFile(
    path.join(srcDir, "app.js"),
    'export function greet(name) {\n  return "DIRTY " + name;\n}\n',
    "utf8",
  );
  await writeFile(path.join(repoDir, "source-only.txt"), "source only\n", "utf8");
  const sourceStatusBefore = await git(repoDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv({ AGENTDOCK_STATE_DIR: stateDir }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "agentdock-ticket02-blackbox", version: "0.1.0" },
    { capabilities: {} },
  );

  t.after(async () => {
    try {
      await client.close();
    } catch {
      // Best-effort.
    }
    await removeLinkedWorktrees(repoDir);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    "task.create",
    "file.read",
    "file.search",
    "file.patch",
    "file.write",
    "git.diff",
  ]) {
    assert.equal(toolNames.has(required), true, "missing MCP tool " + required);
  }

  const task = dataFrom(
    await client.callTool({
      name: "task.create",
      arguments: { repo_path: repoDir },
    }),
  );

  const escapedRead = await client.callTool({
    name: "file.read",
    arguments: { task_id: task.task_id, path: "src/escape-link" },
  });
  assert.equal(escapedRead.isError, true);
  const escapedError = dataFrom(escapedRead);
  assert.equal(escapedError.error.code, "PATH_OUTSIDE_WORKTREE", JSON.stringify(escapedError));

  const appRead = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "src/app.js" },
    }),
  );
  assert.equal(
    appRead.content,
    'export function greet(name) {\n  return "Hello " + name;\n}\n',
  );
  assert.match(appRead.sha256, /^[0-9a-f]{64}$/);

  const search = dataFrom(
    await client.callTool({
      name: "file.search",
      arguments: {
        task_id: task.task_id,
        query: "greet",
        path: "src",
        glob: "**/*.js",
      },
    }),
  );
  assert.deepEqual(
    search.matches.map((match) => [match.path, match.line, match.column]),
    [["src/app.js", 1, 17]],
  );

  const patch = dataFrom(
    await client.callTool({
      name: "file.patch",
      arguments: {
        task_id: task.task_id,
        path: "src/app.js",
        expected_sha256: appRead.sha256,
        old_text: 'return "Hello " + name;',
        new_text: 'return "Hello, " + name + "!";',
      },
    }),
  );
  assert.notEqual(patch.sha256, appRead.sha256);

  const patchedRead = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "src/app.js" },
    }),
  );
  assert.match(patchedRead.content, /Hello, /);

  const created = dataFrom(
    await client.callTool({
      name: "file.write",
      arguments: {
        task_id: task.task_id,
        path: "src/new-module.js",
        content: 'export const createdBy = "AgentDock";\n',
      },
    }),
  );
  assert.equal(created.path, "src/new-module.js");

  const staleRead = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "src/stale.js" },
    }),
  );

  const overwritten = await client.callTool({
    name: "file.write",
    arguments: {
      task_id: task.task_id,
      path: "src/stale.js",
      content: 'export const value = "intervening";\n',
      overwrite: true,
    },
  });
  assert.equal(overwritten.isError, undefined);

  const stalePatch = await client.callTool({
    name: "file.patch",
    arguments: {
      task_id: task.task_id,
      path: "src/stale.js",
      expected_sha256: staleRead.sha256,
      old_text: '"original"',
      new_text: '"should-not-apply"',
    },
  });
  assert.equal(stalePatch.isError, true);
  const staleError = dataFrom(stalePatch);
  assert.equal(staleError.error.code, "PATCH_CONFLICT");

  const staleAfter = dataFrom(
    await client.callTool({
      name: "file.read",
      arguments: { task_id: task.task_id, path: "src/stale.js" },
    }),
  );
  assert.equal(staleAfter.content, 'export const value = "intervening";\n');

  const diff = dataFrom(
    await client.callTool({
      name: "git.diff",
      arguments: { task_id: task.task_id },
    }),
  );

  const changedPaths = new Set(diff.changed_files.map((entry) => entry.path));
  assert.equal(changedPaths.has("src/app.js"), true);
  assert.equal(changedPaths.has("src/stale.js"), true);
  assert.equal(changedPaths.has("src/new-module.js"), true);
  assert.match(diff.patch, /Hello,/);
  assert.match(diff.patch, /createdBy/);

  // Source working tree must remain byte-for-byte in the same dirty state.
  assert.equal(await git(repoDir, ["rev-parse", "HEAD"]), sourceHeadBefore);
  assert.equal(
    await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    sourceStatusBefore,
  );
  assert.equal(
    await readFile(path.join(srcDir, "app.js"), "utf8"),
    'export function greet(name) {\n  return "DIRTY " + name;\n}\n',
  );
  assert.equal(
    await readFile(path.join(repoDir, "source-only.txt"), "utf8"),
    "source only\n",
  );
});
