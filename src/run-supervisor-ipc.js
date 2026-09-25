import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AgentDockError } from "./errors.js";
import { SUPERVISOR_RUNTIME_ID } from "./run-supervisor.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function wireError(error) {
  return {
    code: error?.code ?? "SUPERVISOR_INTERNAL_ERROR",
    message: error?.message ?? String(error),
    details: error?.details ?? null,
  };
}

function fromWireError(error) {
  return new AgentDockError(
    error?.code ?? "SUPERVISOR_INTERNAL_ERROR",
    error?.message ?? "Run Supervisor request failed.",
    error?.details ?? undefined,
  );
}

function parseLines(socket, onMessage) {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered, "utf8") > MAX_FRAME_BYTES) {
      socket.destroy(new Error("Supervisor IPC frame exceeds 1 MiB."));
      return;
    }
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) onMessage(line);
    }
  });
}

export class UnixRunSupervisorClient {
  #socketPath;
  #requestTimeoutMs;

  constructor({ socketPath, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.#socketPath = socketPath;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get instanceId() {
    return SUPERVISOR_RUNTIME_ID;
  }

  request(action, args = {}) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const socket = net.createConnection({ path: this.#socketPath });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new AgentDockError(
          "SUPERVISOR_TIMEOUT",
          "Run Supervisor IPC request timed out.",
          { action },
        ));
      }, this.#requestTimeoutMs);
      timeout.unref?.();

      const finish = (callback, value) => {
        clearTimeout(timeout);
        socket.destroy();
        callback(value);
      };
      socket.once("error", (error) => finish(
        reject,
        new AgentDockError(
          "SUPERVISOR_UNAVAILABLE",
          "Cannot connect to the AgentDock Run Supervisor.",
          { socket_path: this.#socketPath, cause: error.message },
        ),
      ));
      socket.once("connect", () => {
        socket.write(JSON.stringify({ id: requestId, action, args }) + "\n");
      });
      parseLines(socket, (line) => {
        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          finish(reject, new AgentDockError(
            "SUPERVISOR_PROTOCOL_ERROR",
            "Run Supervisor returned invalid JSON.",
            { cause: error.message },
          ));
          return;
        }
        if (response.id !== requestId) return;
        if (response.ok) finish(resolve, response.result);
        else finish(reject, fromWireError(response.error));
      });
    });
  }

  status() {
    return this.request("supervisorStatus");
  }
}

async function removeStaleSocket(socketPath) {
  try {
    const entry = await lstat(socketPath);
    if (!entry.isSocket()) {
      throw new AgentDockError(
        "SUPERVISOR_SOCKET_UNSAFE",
        "Refusing to replace a non-socket Supervisor path.",
        { socket_path: socketPath },
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  await new Promise((resolve, reject) => {
    const probe = net.createConnection({ path: socketPath });
    probe.once("connect", () => {
      probe.destroy();
      reject(new AgentDockError(
        "SUPERVISOR_ALREADY_RUNNING",
        "A live Run Supervisor already owns this socket.",
        { socket_path: socketPath },
      ));
    });
    probe.once("error", () => {
      probe.destroy();
      resolve();
    });
  });
  await rm(socketPath, { force: true });
}

export async function listenRunSupervisor({ supervisor, socketPath }) {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    parseLines(socket, async (line) => {
      let request;
      try {
        request = JSON.parse(line);
        if (!request?.id || typeof request.action !== "string") {
          throw new AgentDockError(
            "SUPERVISOR_PROTOCOL_ERROR",
            "Supervisor request requires id and action.",
          );
        }
        const result = request.action === "supervisorStatus"
          ? supervisor.status()
          : await supervisor.request(request.action, request.args ?? {});
        socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
      } catch (error) {
        socket.write(JSON.stringify({
          id: request?.id ?? null,
          ok: false,
          error: wireError(error),
        }) + "\n");
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      await rm(socketPath, { force: true });
    },
  };
}
