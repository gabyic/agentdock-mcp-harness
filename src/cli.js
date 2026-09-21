#!/usr/bin/env node
import { runDoctor, formatDoctorReport } from "./doctor-service.js";

function usage() {
  return [
    "Usage: agentdock doctor [--json] [--config PATH]",
    "",
    "Options:",
    "  --json          Emit machine-readable JSON.",
    "  --config PATH   Diagnose using an explicit AgentDock config file.",
    "  -h, --help      Show this help.",
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
const command = args.shift();

if (command === undefined || command === "-h" || command === "--help") {
  process.stdout.write(usage());
  process.exit(0);
}

if (command !== "doctor") {
  process.stderr.write("Unknown command: " + command + "\n\n" + usage());
  process.exit(2);
}

let json = false;
let configPath;
while (args.length > 0) {
  const arg = args.shift();
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg === "--config") {
    const value = args.shift();
    if (!value) {
      process.stderr.write("--config requires a path.\n");
      process.exit(2);
    }
    configPath = value;
    continue;
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(usage());
    process.exit(0);
  }

  process.stderr.write("Unknown option: " + arg + "\n");
  process.exit(2);
}

const report = await runDoctor({ configPath });
if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write(formatDoctorReport(report));
}

process.exitCode = report.overall_status === "FAIL" ? 1 : 0;
