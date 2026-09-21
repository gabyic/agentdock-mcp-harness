#!/usr/bin/env node
import { runDoctor, formatDoctorReport } from "./doctor-service.js";
import {
  runUpgradeCommand,
  runUninstallCommand,
} from "./lifecycle-service.js";
import { AGENTDOCK_VERSION } from "./version.js";

function usage() {
  return [
    "Usage:",
    "  agentdock doctor [--json] [--config PATH]",
    "  agentdock upgrade --source PATH [--skip-tests] [--allow-downgrade] [--force]",
    "  agentdock uninstall [--remove-state] [--state-dir PATH] [--remove-config] [--config PATH]",
    "  agentdock version",
    "",
    "Commands:",
    "  doctor       Diagnose the current AgentDock runtime and configuration.",
    "  upgrade      Upgrade a managed install from a local checkout/release.",
    "  uninstall    Remove a managed install; state/config are preserved by default.",
    "  version      Print the AgentDock version.",
    "",
    "Use 'agentdock <command> --help' for command-specific options.",
    "",
  ].join("\n");
}

function doctorUsage() {
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

function upgradeUsage() {
  return [
    "Usage: agentdock upgrade --source PATH [options]",
    "",
    "Options:",
    "  --source PATH        New checkout or extracted release directory.",
    "  --skip-tests         Skip source tests before upgrading.",
    "  --allow-downgrade    Permit an intentional version downgrade.",
    "  --force              Reinstall the same version.",
    "  -h, --help           Show this help.",
    "",
    "Upgrade never downloads code automatically.",
    "",
  ].join("\n");
}

function uninstallUsage() {
  return [
    "Usage: agentdock uninstall [options]",
    "",
    "Options:",
    "  --remove-state       Permanently remove durable AgentDock state.",
    "  --state-dir PATH     Explicit state path for --remove-state.",
    "  --remove-config      Remove the selected AgentDock config file.",
    "  --config PATH        Config path used for removal/state resolution.",
    "  -h, --help           Show this help.",
    "",
    "By default state and configuration are preserved.",
    "",
  ].join("\n");
}

function usageError(message, commandUsage = usage()) {
  process.stderr.write(message + "\n\n" + commandUsage);
  process.exit(2);
}

async function runDoctorCli(args) {
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
      if (!value) usageError("--config requires a path.", doctorUsage());
      configPath = value;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(doctorUsage());
      return 0;
    }
    usageError("Unknown doctor option: " + arg, doctorUsage());
  }

  const report = await runDoctor({ configPath });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatDoctorReport(report));
  }
  return report.overall_status === "FAIL" ? 1 : 0;
}

function runUpgradeCli(args) {
  let sourceDir;
  const forwarded = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--source") {
      const value = args.shift();
      if (!value) usageError("--source requires a path.", upgradeUsage());
      sourceDir = value;
      continue;
    }
    if (["--skip-tests", "--allow-downgrade", "--force"].includes(arg)) {
      forwarded.push(arg);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(upgradeUsage());
      return 0;
    }
    usageError("Unknown upgrade option: " + arg, upgradeUsage());
  }

  try {
    return runUpgradeCommand({ sourceDir, args: forwarded });
  } catch (error) {
    process.stderr.write((error?.message ?? String(error)) + "\n");
    return error?.code === "UPGRADE_SOURCE_REQUIRED" ? 2 : 1;
  }
}

function runUninstallCli(args) {
  const forwarded = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (["--remove-state", "--remove-config"].includes(arg)) {
      forwarded.push(arg);
      continue;
    }
    if (arg === "--state-dir" || arg === "--config") {
      const value = args.shift();
      if (!value) usageError(arg + " requires a path.", uninstallUsage());
      forwarded.push(arg, value);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(uninstallUsage());
      return 0;
    }
    usageError("Unknown uninstall option: " + arg, uninstallUsage());
  }

  try {
    return runUninstallCommand({ args: forwarded });
  } catch (error) {
    process.stderr.write((error?.message ?? String(error)) + "\n");
    return 1;
  }
}

const args = process.argv.slice(2);
const command = args.shift();

if (command === undefined || command === "-h" || command === "--help") {
  process.stdout.write(usage());
  process.exit(0);
}

let exitCode;
switch (command) {
  case "doctor":
    exitCode = await runDoctorCli(args);
    break;
  case "upgrade":
    exitCode = runUpgradeCli(args);
    break;
  case "uninstall":
    exitCode = runUninstallCli(args);
    break;
  case "version":
  case "--version":
  case "-V":
    if (args.length > 0) usageError("version takes no options.");
    process.stdout.write(AGENTDOCK_VERSION + "\n");
    exitCode = 0;
    break;
  default:
    usageError("Unknown command: " + command);
}

process.exitCode = exitCode;
