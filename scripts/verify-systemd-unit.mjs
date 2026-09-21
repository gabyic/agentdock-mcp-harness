#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const unitPath =
  process.argv[2] ??
  path.join(
    projectRoot,
    "deploy",
    "systemd",
    "agentdock-http.service",
  );

const text = await readFile(unitPath, "utf8");
const lines = text
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

let section = "";
const entries = new Map();
for (const line of lines) {
  const sectionMatch = line.match(/^\[([^\]]+)\]$/);
  if (sectionMatch) {
    section = sectionMatch[1];
    continue;
  }
  const index = line.indexOf("=");
  if (index <= 0) continue;
  const key = section + "." + line.slice(0, index);
  const value = line.slice(index + 1);
  const values = entries.get(key) ?? [];
  values.push(value);
  entries.set(key, values);
}

const requireValue = (key, expected) => {
  const values = entries.get(key) ?? [];
  if (!values.includes(expected)) {
    throw new Error(
      unitPath +
        ": expected " +
        key +
        "=" +
        expected +
        ", got " +
        JSON.stringify(values),
    );
  }
};

requireValue("Service.Type", "simple");
requireValue("Service.Environment", "AGENTDOCK_TRANSPORT=http");
requireValue(
  "Service.ExecStart",
  "%h/.local/bin/agentdock-mcp",
);
requireValue(
  "Service.ExecStartPost",
  "%h/.local/bin/agentdock health --wait-ms 10000 --timeout-ms 1000",
);
requireValue("Service.Restart", "always");
requireValue("Service.KillMode", "control-group");
requireValue("Service.KillSignal", "SIGTERM");
requireValue("Service.SendSIGKILL", "yes");
requireValue("Service.FinalKillSignal", "SIGKILL");
requireValue("Service.TimeoutStopSec", "15");
requireValue("Service.UMask", "0077");

const restartValues = entries.get("Service.Restart") ?? [];
if (restartValues.includes("on-failure")) {
  throw new Error(
    unitPath +
      ": Restart=on-failure does not recover from a clean SIGTERM.",
  );
}

process.stdout.write("SYSTEMD_UNIT_CONTRACT=PASS\n");
