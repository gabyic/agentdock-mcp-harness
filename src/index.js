#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAgentDockServer } from "./server.js";

serveStdio(() => createAgentDockServer().server);
console.error("AgentDock MCP server running on stdio (2026-07-28 capable)");
