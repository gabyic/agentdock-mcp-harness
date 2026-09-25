import { loadAgentDockConfig } from "./config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHealthUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Health URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Health URL must not contain embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Health URL must not contain query parameters or fragments.");
  }
  return parsed;
}

function urlFromConfig(config) {
  if (config.transport.mode !== "http") {
    throw new Error(
      "Configured transport is stdio; provide --url for an external health endpoint.",
    );
  }

  const http = config.transport.http;
  let host = http.host;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::" || host === "[::]") host = "[::1]";
  if (host.includes(":") && !host.startsWith("[")) {
    host = "[" + host + "]";
  }
  return new URL(
    "http://" + host + ":" + http.port + http.health_path,
  );
}

async function probe(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });
    const latencyMs = Date.now() - started;
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const healthy = response.ok && isReadyHealthPayload(body);

    return {
      healthy,
      status_code: response.status,
      latency_ms: latencyMs,
      response: body,
      error: healthy
        ? null
        : "Health endpoint did not report ready SQLite state and Run Supervisor.",
    };
  } catch (error) {
    return {
      healthy: false,
      status_code: null,
      latency_ms: Date.now() - started,
      response: null,
      error:
        error?.name === "AbortError"
          ? "Health request timed out."
          : error?.message ?? String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function isReadyHealthPayload(body) {
  return (
    body?.status === "ok" &&
    body?.transport === "streamable-http" &&
    body?.state_backend === "sqlite" &&
    body?.supervisor?.ready === true
  );
}

export async function runHealthCheck({
  url,
  waitMs = 0,
  timeoutMs = 1000,
  intervalMs = 100,
  env = process.env,
  homeDir,
  configPath,
} = {}) {
  if (!Number.isInteger(waitMs) || waitMs < 0) {
    throw new TypeError("waitMs must be a non-negative integer.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 10) {
    throw new TypeError("intervalMs must be an integer >= 10.");
  }

  let target;
  if (url) {
    target = normalizeHealthUrl(url);
  } else {
    const { config } = loadAgentDockConfig({
      env,
      ...(homeDir === undefined ? {} : { homeDir }),
      ...(configPath === undefined ? {} : { configPath }),
    });
    target = urlFromConfig(config);
  }

  const deadline = Date.now() + waitMs;
  let attempts = 0;
  let last;

  do {
    attempts += 1;
    last = await probe(target, timeoutMs);
    if (last.healthy) {
      return {
        status: "PASS",
        url: target.toString(),
        attempts,
        ...last,
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(
      Math.min(intervalMs, Math.max(0, deadline - Date.now())),
    );
  } while (Date.now() <= deadline);

  return {
    status: "FAIL",
    url: target.toString(),
    attempts,
    ...last,
  };
}

export function formatHealthReport(result) {
  const line =
    "[" +
    result.status +
    "] health — " +
    (result.healthy ? "AgentDock is healthy." : result.error);
  return (
    line +
    "\n" +
    "    url: " +
    result.url +
    "\n" +
    "    attempts: " +
    result.attempts +
    "\n" +
    "    status_code: " +
    String(result.status_code) +
    "\n" +
    "    latency_ms: " +
    result.latency_ms +
    "\n"
  );
}
