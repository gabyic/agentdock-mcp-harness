import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitService } from "./git-service.js";
import { TaskService } from "./task-service.js";

function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function createAgentDockServer({ stateDir } = {}) {
  const gitService = new GitService();
  const taskService = new TaskService({ gitService, stateDir });

  const server = new McpServer(
    { name: "AgentDock", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "repo.inspect",
    "Inspect a local Git repository without modifying its working tree.",
    { path: z.string().min(1).describe("Path inside the Git repository") },
    { readOnlyHint: true },
    async ({ path }) => toolResult(await gitService.inspect(path)),
  );

  server.tool(
    "task.create",
    "Create an ACTIVE coding task in a clean detached Git worktree based on the source repository HEAD.",
    {
      repo_path: z.string().min(1).describe("Path inside the source Git repository"),
    },
    async ({ repo_path }) =>
      toolResult(await taskService.create({ repoPath: repo_path })),
  );

  return { server };
}
