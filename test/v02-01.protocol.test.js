import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function cleanEnv(stateDir) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    AGENTDOCK_STATE_DIR: stateDir,
  };
}

async function connect({ stateDir, mode }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: cleanEnv(stateDir),
    stderr: "pipe",
  });

  const options =
    mode === "modern"
      ? {
          capabilities: {},
          versionNegotiation: { mode: { pin: "2026-07-28" } },
        }
      : { capabilities: {} };

  const client = new Client(
    { name: "agentdock-v02-01-" + mode, version: "0.2.0-dev" },
    options,
  );
  await client.connect(transport);
  return { client, transport };
}

test("v0.2-01: stdio serves legacy and 2026-07-28 with the same tool surface", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v02-01-"));
  const legacy = await connect({
    stateDir: path.join(tempRoot, "legacy"),
    mode: "legacy",
  });
  const modern = await connect({
    stateDir: path.join(tempRoot, "modern"),
    mode: "modern",
  });

  t.after(async () => {
    await Promise.allSettled([legacy.client.close(), modern.client.close()]);
    await rm(tempRoot, { recursive: true, force: true });
  });

  assert.equal(legacy.client.getProtocolEra(), "legacy");
  assert.equal(modern.client.getProtocolEra(), "modern");

  const legacyTools = (await legacy.client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  const modernToolDescriptors = (await modern.client.listTools()).tools;
  const modernTools = modernToolDescriptors
    .map((tool) => tool.name)
    .sort();

  for (const tool of modernToolDescriptors) {
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", tool.name);
  }

  assert.deepEqual(modernTools, legacyTools);
  assert.equal(modernTools.includes("task.create"), true);
  assert.equal(modernTools.includes("process.start"), true);
  assert.equal(modernTools.includes("run.start"), true);
  assert.equal(modernTools.includes("run.get"), true);
  assert.equal(modernTools.includes("run.cancel"), true);
  assert.equal(modernTools.includes("plan.start"), true);
  assert.equal(modernTools.includes("plan.get"), true);
  assert.equal(modernTools.includes("plan.cancel"), true);
  assert.equal(modernTools.includes("audit.get"), true);
  assert.equal(modernTools.includes("skill.install"), true);
  assert.equal(modernTools.includes("skill.read"), true);
  assert.equal(modernTools.includes("skill.invoke"), true);
  assert.equal(modernTools.includes("workflow.start"), true);
  assert.equal(modernTools.includes("workflow.list"), true);
  assert.equal(modernTools.includes("workflow.status"), true);
  assert.equal(modernTools.includes("workflow.update"), true);
  assert.equal(modernTools.includes("workflow.guide"), true);
});
