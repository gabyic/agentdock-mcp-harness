#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadAgentDockConfig } from "./config.js";
import {
  createAgentDockRuntime,
  createAgentDockServer,
} from "./server.js";
import { listenAgentDockHttpFromConfig } from "./http-server.js";

const { config } = loadAgentDockConfig();

if (config.transport.mode === "http") {
  const instance = await listenAgentDockHttpFromConfig(config);
  console.error(
    `AgentDock Streamable HTTP listening on http://${instance.host}:${instance.port}${instance.mcpPath}`,
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`AgentDock HTTP received ${signal}; shutting down.`);
    await instance.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} else {
  const runtime = createAgentDockRuntime({ config });
  serveStdio(() => createAgentDockServer({ runtime }).server);
  console.error("AgentDock MCP server running on stdio (2026-07-28 capable)");
}
