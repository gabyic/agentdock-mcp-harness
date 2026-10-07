// v0.5-01: process tools that an agent can use without burning context.
// process.output can block (wait_ms / until), return plain text instead of chunk arrays, and keep only the
// tail; process.start can skip echoing the command back; process.exec starts and waits in one call.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function dataFrom(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool result should contain JSON text: " + JSON.stringify(result));
  return JSON.parse(text);
}

async function waitForPath(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error("timed out waiting for " + file);
}

async function harness(t, mode) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v05-01-"));
  const repoDir = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, ["config", "user.name", "AgentDock Test"]);
  await git(repoDir, ["config", "user.email", "agentdock-test@example.invalid"]);
  await writeFile(path.join(repoDir, "README.md"), "x\n", "utf8");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial"]);
  const baseEnv = { ...process.env, HOME: tempRoot, AGENTDOCK_STATE_DIR: path.join(tempRoot, "state") };
  delete baseEnv.AGENTDOCK_CONFIG;
  let env = baseEnv;
  if (mode === "supervisor") {
    const socketPath = path.join(tempRoot, "run-supervisor.sock");
    const daemonEnv = { ...baseEnv, AGENTDOCK_STATE_BACKEND: "sqlite", AGENTDOCK_SUPERVISOR_SOCKET: socketPath };
    const daemon = spawn(process.execPath, [path.join(projectRoot, "src", "supervisor.js")], {
      env: daemonEnv, stdio: ["ignore", "ignore", "ignore"],
    });
    t.after(async () => {
      try { daemon.kill("SIGTERM"); } catch { /* gone */ }
      await new Promise((resolve) => (daemon.exitCode !== null ? resolve() : daemon.once("exit", resolve)));
    });
    await waitForPath(socketPath);
    env = { ...daemonEnv, AGENTDOCK_SUPERVISOR_MODE: "client" };
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agentdock-v05-01", version: "0.1.0" }, { capabilities: {} });
  t.after(async () => {
    try { await client.close(); } catch { /* best effort */ }
    await rm(tempRoot, { recursive: true, force: true });
  });
  await client.connect(transport);
  const task = dataFrom(await client.callTool({ name: "task.create", arguments: { repo_path: repoDir } }));
  const call = async (name, args) => dataFrom(await client.callTool({ name, arguments: { task_id: task.task_id, ...args } }));
  return { client, call };
}

for (const mode of ["local", "supervisor"]) test(`v0.5-01 [${mode}]: process.output waits for the process to exit instead of returning at once`, async (t) => {
  const { call } = await harness(t, mode);
  const started = await call("process.start", { shell: "echo early; sleep 1; echo late" });
  const t0 = Date.now();
  const out = await call("process.output", { process_id: started.process_id, wait_ms: 15000, until: "exit", view: "text" });
  assert.equal(out.status, "EXITED");
  assert.equal(out.exit_code, 0);
  assert.equal(out.stdout, "early\nlate\n");
  assert.ok(Date.now() - t0 >= 800, "should have blocked until the process ended");
});

for (const mode of ["local", "supervisor"]) test(`v0.5-01 [${mode}]: wait_ms alone still returns as soon as new output arrives`, async (t) => {
  const { call } = await harness(t, mode);
  const started = await call("process.start", { shell: "sleep 0.3; echo hi; sleep 5" });
  const t0 = Date.now();
  const out = await call("process.output", { process_id: started.process_id, wait_ms: 10000, view: "text" });
  assert.equal(out.stdout, "hi\n");
  assert.equal(out.status, "RUNNING");
  assert.ok(Date.now() - t0 < 4000);
  await call("process.cancel", { process_id: started.process_id });
});

for (const mode of ["local", "supervisor"]) test(`v0.5-01 [${mode}]: text view carries the output once, without the chunk array`, async (t) => {
  const { call } = await harness(t, mode);
  const started = await call("process.start", { shell: "echo out; echo err 1>&2" });
  const out = await call("process.output", { process_id: started.process_id, wait_ms: 5000, until: "exit", view: "text" });
  assert.equal("chunks" in out, false);
  assert.equal("stdout_chunk" in out, false);
  assert.equal(out.stdout, "out\n");
  assert.equal(out.stderr, "err\n");
  assert.equal(typeof out.next_cursor, "number");
  // the default view is unchanged for existing clients
  const full = await call("process.output", { process_id: started.process_id });
  assert.ok(Array.isArray(full.chunks));
  assert.equal(full.stdout_chunk, "out\n");
});

for (const mode of ["local", "supervisor"]) test(`v0.5-01 [${mode}]: tail_lines keeps only the last lines of everything available`, async (t) => {
  const { call } = await harness(t, mode);
  const started = await call("process.start", { shell: "seq 1 20000" });
  const out = await call("process.output", { process_id: started.process_id, wait_ms: 10000, until: "exit", view: "text", tail_lines: 3 });
  assert.equal(out.stdout, "19998\n19999\n20000\n");
  assert.ok(out.stdout_lines_dropped > 0);
  assert.equal(out.has_more, false);
});

for (const mode of ["local", "supervisor"]) test(`v0.5-01 [${mode}]: process.start can skip echoing the command back`, async (t) => {
  const { call } = await harness(t, mode);
  const quiet = await call("process.start", { shell: "echo secret-ish-long-script", echo: false });
  assert.equal("shell" in quiet, false);
  assert.equal("argv" in quiet, false);
  assert.equal("env" in quiet, false);
  assert.match(quiet.process_id, /^proc_/);
  const loud = await call("process.start", { shell: "true" });
  assert.equal(loud.shell, "true");
});

for (const mode of ["local", "supervisor"]) test(`v0.5-01 [${mode}]: process.exec starts, waits and returns the output tail in one call`, async (t) => {
  const { client, call } = await harness(t, mode);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("process.exec"), names.join(", "));

  const done = await call("process.exec", { shell: "seq 1 5; echo bad 1>&2; exit 3", tail_lines: 2 });
  assert.equal(done.status, "EXITED");
  assert.equal(done.exit_code, 3);
  assert.equal(done.timed_out, false);
  assert.equal(done.stdout, "4\n5\n");
  assert.equal(done.stderr, "bad\n");
  assert.equal("shell" in done, false);

  const slow = await call("process.exec", { shell: "echo begun; sleep 5", wait_ms: 500 });
  assert.equal(slow.timed_out, true);
  assert.equal(slow.status, "RUNNING");
  assert.equal(slow.stdout, "begun\n");
  // the caller continues with process.output from where exec stopped
  const rest = await call("process.output", { process_id: slow.process_id, cursor: slow.next_cursor, view: "text" });
  assert.equal(rest.stdout, "");
  await call("process.cancel", { process_id: slow.process_id });
});
