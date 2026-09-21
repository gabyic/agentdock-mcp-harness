#!/usr/bin/env node
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  LOCAL_HOSTNAMES,
  listenAgentDockHttp,
} from "./http-server.js";

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLoopbackHost(host) {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENTDOCK_HTTP_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

const host = process.env.AGENTDOCK_HTTP_HOST ?? DEFAULT_HTTP_HOST;
const port = parsePort(
  process.env.AGENTDOCK_HTTP_PORT ?? String(DEFAULT_HTTP_PORT),
);

const explicitAllowedHosts = process.env.AGENTDOCK_HTTP_ALLOWED_HOSTS;
if (!explicitAllowedHosts && !isLoopbackHost(host)) {
  throw new Error(
    "AGENTDOCK_HTTP_ALLOWED_HOSTS is required when binding HTTP beyond loopback.",
  );
}

const allowedHosts = explicitAllowedHosts
  ? parseList(explicitAllowedHosts)
  : LOCAL_HOSTNAMES;
const allowedOrigins = process.env.AGENTDOCK_HTTP_ALLOWED_ORIGINS
  ? parseList(process.env.AGENTDOCK_HTTP_ALLOWED_ORIGINS)
  : allowedHosts;

const instance = await listenAgentDockHttp({
  host,
  port,
  stateDir: process.env.AGENTDOCK_STATE_DIR,
  mcpPath: process.env.AGENTDOCK_HTTP_PATH ?? "/mcp",
  allowedHosts,
  allowedOrigins,
});

console.error(
  `AgentDock Streamable HTTP listening on http://${host}:${instance.port}${instance.mcpPath}`,
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
