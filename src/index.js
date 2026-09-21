#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadAgentDockConfig } from "./config.js";
import {
  createAgentDockRuntime,
  createAgentDockServer,
} from "./server.js";
import { listenAgentDockHttpFromConfig } from "./http-server.js";
import { installSignalHandlers } from "./service-lifecycle.js";

const { config } = loadAgentDockConfig();

if (config.transport.mode === "http") {
  const instance = await listenAgentDockHttpFromConfig(config);
  console.error(
    `AgentDock Streamable HTTP listening on http://${instance.host}:${instance.port}${instance.mcpPath}`,
  );

  installSignalHandlers({
    runtime: instance.runtime,
    beginShutdown: () => instance.beginShutdown(),
    closeTransport: () => instance.close(),
  });
} else {
  const runtime = createAgentDockRuntime({ config });
  const stdio = serveStdio(
    () => createAgentDockServer({ runtime }).server,
  );
  installSignalHandlers({
    runtime,
    closeTransport: () => stdio.close(),
  });
  console.error("AgentDock MCP server running on stdio (2026-07-28 capable)");
}
