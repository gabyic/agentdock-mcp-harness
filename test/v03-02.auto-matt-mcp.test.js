import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { loadAgentDockConfig } from "../src/config.js";
import { listenAgentDockHttp } from "../src/http-server.js";
import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentDock Test",
      GIT_AUTHOR_EMAIL: "agentdock@example.invalid",
      GIT_COMMITTER_NAME: "AgentDock Test",
      GIT_COMMITTER_EMAIL: "agentdock@example.invalid",
    },
  });
}

async function writeSkill(repo, name, body) {
  const dir = path.join(repo, "skills", "engineering", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    [
      "---",
      "name: " + name,
      "description: " + JSON.stringify(body),
      "disable-model-invocation: true",
      "---",
      "",
      "# " + name,
      "",
      body,
      "",
    ].join("\n"),
  );
}

async function createSkillRepo(root) {
  const repo = path.join(root, "skills");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await writeSkill(
    repo,
    "ask-matt",
    "Router over the engineering workflow. Pick the best workflow skill.",
  );
  await writeSkill(
    repo,
    "wayfinder",
    "Map a large multi-session effort whose route is still foggy.",
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

async function configureProject(project) {
  await mkdir(path.join(project, "docs", "agents"), { recursive: true });
  await writeFile(
    path.join(project, "docs", "agents", "issue-tracker.md"),
    "# tracker\n",
  );
  await writeFile(
    path.join(project, "docs", "agents", "domain.md"),
    "# domain\n",
  );
  await writeFile(
    path.join(project, "AGENTS.md"),
    "# Agent instructions\n\n## Agent skills\n",
  );
}

test("v0.3-05: Auto Matt routes through the same MCP skill.invoke surface and consumes durable workflow context", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v03-auto-mcp-"));
  const stateDir = path.join(tempRoot, "state");
  const project = path.join(tempRoot, "project");
  await mkdir(project);
  await configureProject(project);
  const skillRepo = await createSkillRepo(tempRoot);

  const { config } = loadAgentDockConfig({
    homeDir: tempRoot,
    configPath: null,
    env: {
      AGENTDOCK_STATE_DIR: stateDir,
      AGENTDOCK_MATT_AUTO_ROUTING: "true",
    },
  });
  const runtime = createAgentDockRuntime({ config });
  await runtime.skillService.install({
    sourceId: "mattpocock",
    repoUrl: "file://" + skillRepo,
    ref: "main",
  });
  await runtime.workflowService.start({
    repoPath: project,
    goal: "Build a large feature.",
    sessionSpan: "multi",
    routeClarity: "foggy",
  });

  const instance = await listenAgentDockHttp({
    runtime,
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client(
    { name: "agentdock-auto-matt-test", version: "0.3.0-dev" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:" + instance.port + instance.mcpPath),
  );
  await client.connect(transport);

  t.after(async () => {
    await Promise.allSettled([client.close(), instance.close()]);
    await rm(tempRoot, { recursive: true, force: true });
  });

  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 34);
  assert.equal(tools.some((entry) => entry.name === "skill.invoke"), true);

  const routed = await client.callTool({
    name: "skill.invoke",
    arguments: {
      skill_name: "auto",
      source_id: "mattpocock",
      invocation_mode: "model",
      request: "Continue this large project; I do not know the next step.",
      repo_path: project,
    },
  });
  assert.notEqual(routed.isError, true);
  assert.equal(routed.structuredContent.authorization.mode, "auto_authorized");
  assert.equal(
    routed.structuredContent.routing.workflow_recommended_skill,
    "wayfinder",
  );
  assert.equal(
    routed.structuredContent.workflow_context.workflow.phase,
    "WAYFINDING",
  );

  const invoked = await client.callTool({
    name: "skill.invoke",
    arguments: {
      skill_name: "wayfinder",
      source_id: "mattpocock",
      invocation_mode: "model",
      request: "Continue this large project using the routed method.",
      repo_path: project,
    },
  });
  assert.notEqual(invoked.isError, true);
  assert.equal(invoked.structuredContent.skill.name, "wayfinder");
  assert.equal(invoked.structuredContent.authorization.mode, "auto_authorized");
  assert.equal(invoked.structuredContent.execution_contract.server_side_llm, false);
});
