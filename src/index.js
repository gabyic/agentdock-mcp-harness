#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentDockServer } from "./server.js";

const { server } = createAgentDockServer();
const transport = new StdioServerTransport();

await server.connect(transport);
console.error("AgentDock v0.1 MCP server running on stdio");
