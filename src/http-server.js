import { createServer } from "node:http";
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  DEFAULT_HTTP_HEALTH_PATH,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  LOCAL_HOSTNAMES,
} from "./config.js";
import {
  createAgentDockRuntime,
  createAgentDockServer,
} from "./server.js";

export {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  LOCAL_HOSTNAMES,
};
export const DEFAULT_MCP_PATH = DEFAULT_HTTP_PATH;
export const DEFAULT_HEALTH_PATH = DEFAULT_HTTP_HEALTH_PATH;

function normalizePath(value, name) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(name + " must start with '/'.");
  }
  return value;
}

function normalizeHostnameList(values, name) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(name + " must contain at least one hostname.");
  }

  const normalized = values.map((value) => String(value).trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error(name + " must contain at least one hostname.");
  }
  return [...new Set(normalized)];
}

function writeJson(res, statusCode, payload, headers = {}) {
  if (res.headersSent || res.destroyed) {
    return;
  }

  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

export function createAgentDockHttpServer({
  runtime,
  stateDir,
  mcpPath = DEFAULT_MCP_PATH,
  healthPath = DEFAULT_HEALTH_PATH,
  allowedHosts = LOCAL_HOSTNAMES,
  allowedOrigins = allowedHosts,
} = {}) {
  const sharedRuntime = runtime ?? createAgentDockRuntime({ stateDir });
  const normalizedMcpPath = normalizePath(mcpPath, "mcpPath");
  const normalizedHealthPath = normalizePath(healthPath, "healthPath");
  const hostnames = normalizeHostnameList(allowedHosts, "allowedHosts");
  const origins = normalizeHostnameList(allowedOrigins, "allowedOrigins");

  const validateHost = hostHeaderValidation(hostnames);
  const validateOrigin = originValidation(origins);

  const mcpHandler = createMcpHandler(
    () => createAgentDockServer({ runtime: sharedRuntime }).server,
    {
      legacy: "stateless",
      onerror: (error) => {
        console.error("AgentDock MCP HTTP handler error:", error);
      },
    },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      console.error("AgentDock Node HTTP adapter error:", error);
    },
  });

  const httpServer = createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      writeJson(res, 400, { error: "Invalid request URL." });
      return;
    }

    if (pathname === normalizedHealthPath) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(
          res,
          405,
          { error: "Method not allowed." },
          { allow: "GET, HEAD" },
        );
        return;
      }

      writeJson(res, 200, {
        status: "ok",
        transport: "streamable-http",
        mode: "stateless",
      });
      return;
    }

    if (pathname !== normalizedMcpPath) {
      writeJson(res, 404, { error: "Not found." });
      return;
    }

    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      writeJson(
        res,
        405,
        { error: "Method not allowed." },
        { allow: "POST, GET, DELETE" },
      );
      return;
    }

    try {
      await nodeMcpHandler(req, res);
    } catch (error) {
      console.error("AgentDock HTTP request failed:", error);
      writeJson(res, 500, { error: "Internal server error." });
    }
  });

  async function close() {
    await new Promise((resolve, reject) => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });

    await mcpHandler.close();
  }

  return {
    httpServer,
    runtime: sharedRuntime,
    mcpPath: normalizedMcpPath,
    healthPath: normalizedHealthPath,
    allowedHosts: hostnames,
    allowedOrigins: origins,
    close,
  };
}

export async function listenAgentDockHttpFromConfig(config) {
  const runtime = createAgentDockRuntime({ config });
  const http = config.transport.http;
  return listenAgentDockHttp({
    runtime,
    host: http.host,
    port: http.port,
    mcpPath: http.path,
    healthPath: http.health_path,
    allowedHosts: http.allowed_hosts,
    allowedOrigins: http.allowed_origins,
  });
}

export async function listenAgentDockHttp({
  host = DEFAULT_HTTP_HOST,
  port = DEFAULT_HTTP_PORT,
  ...options
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("HTTP port must be an integer between 0 and 65535.");
  }

  const instance = createAgentDockHttpServer(options);

  await new Promise((resolve, reject) => {
    instance.httpServer.once("error", reject);
    instance.httpServer.listen(port, host, () => {
      instance.httpServer.off("error", reject);
      resolve();
    });
  });

  const address = instance.httpServer.address();
  return {
    ...instance,
    host,
    port: typeof address === "object" && address ? address.port : port,
  };
}
