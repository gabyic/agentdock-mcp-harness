import {
  existsSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import { AgentDockError } from "./errors.js";

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIG_RELATIVE_PATH = ".config/agentdock/config.json";
export const DEFAULT_STATE_RELATIVE_PATH = ".local/state/agentdock";
export const DEFAULT_PERSISTED_PROCESS_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_AUDIT_MAX_ENTRIES_PER_TASK = 5000;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3100;
export const DEFAULT_HTTP_PATH = "/mcp";
export const DEFAULT_HTTP_HEALTH_PATH = "/healthz";
export const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
export const CONFIG_ENV_KEYS = new Set([
  "AGENTDOCK_CONFIG",
  "AGENTDOCK_STATE_DIR",
  "AGENTDOCK_STATE_BACKEND",
  "AGENTDOCK_PERSISTED_OUTPUT_BYTES",
  "AGENTDOCK_SUPERVISOR_MODE",
  "AGENTDOCK_AUDIT_MAX_ENTRIES",
  "AGENTDOCK_POLICY_JSON",
  "AGENTDOCK_MATT_AUTO_ROUTING",
  "AGENTDOCK_TRANSPORT",
  "AGENTDOCK_HTTP_HOST",
  "AGENTDOCK_HTTP_PORT",
  "AGENTDOCK_HTTP_PATH",
  "AGENTDOCK_HTTP_HEALTH_PATH",
  "AGENTDOCK_HTTP_ALLOWED_HOSTS",
  "AGENTDOCK_HTTP_ALLOWED_ORIGINS",
]);

const PolicyRuleSchema = z
  .object({
    id: z.string().min(1),
    effect: z.enum(["allow", "ask", "deny"]),
    tool: z.string().min(1),
    approval_scope: z.string().min(1).optional(),
    shell_regex: z
      .string()
      .optional()
      .refine(
        (value) => {
          if (value === undefined) return true;
          try {
            new RegExp(value);
            return true;
          } catch {
            return false;
          }
        },
        { message: "shell_regex must be a valid regular expression." },
      ),
    argv_prefix: z.array(z.string()).optional(),
  })
  .strict();

const HttpConfigSchema = z
  .object({
    host: z.string().min(1).default(DEFAULT_HTTP_HOST),
    port: z.number().int().min(1).max(65535).default(DEFAULT_HTTP_PORT),
    path: z.string().startsWith("/").default(DEFAULT_HTTP_PATH),
    health_path: z
      .string()
      .startsWith("/")
      .default(DEFAULT_HTTP_HEALTH_PATH),
    allowed_hosts: z.array(z.string().min(1)).min(1).optional(),
    allowed_origins: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .default({});

const AgentDockConfigSchema = z
  .object({
    version: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
    state: z
      .object({
        dir: z.string().min(1),
        backend: z.enum(["json", "sqlite"]).default("sqlite"),
        persisted_process_output_bytes: z
          .number()
          .int()
          .min(1024)
          .max(64 * 1024 * 1024)
          .default(DEFAULT_PERSISTED_PROCESS_OUTPUT_BYTES),
      })
      .strict(),
    execution: z
      .object({
        supervisor_mode: z.enum(["auto", "owner", "client"]).default("auto"),
      })
      .strict()
      .default({}),
    audit: z
      .object({
        max_entries_per_task: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .default(DEFAULT_AUDIT_MAX_ENTRIES_PER_TASK),
      })
      .strict()
      .default({}),
    policy: z
      .object({
        rules: z.array(PolicyRuleSchema).max(1000).default([]),
      })
      .strict()
      .default({}),
    skills: z
      .object({
        matt_auto_routing: z.boolean().default(false),
        router_skill: z.string().min(1).default("ask-matt"),
      })
      .strict()
      .default({}),
    transport: z
      .object({
        mode: z.enum(["stdio", "http"]).default("stdio"),
        http: HttpConfigSchema,
      })
      .strict()
      .default({}),
  })
  .strict();

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function deepMerge(base, overlay) {
  if (!isPlainObject(overlay)) {
    return overlay === undefined ? base : overlay;
  }

  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

function nestedOwn(object, keys) {
  let current = object;
  for (const key of keys) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) {
      return false;
    }
    current = current[key];
  }
  return true;
}

function expandHome(value, homeDir) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function absolutePath(value, { homeDir, name }) {
  const expanded = expandHome(value, homeDir);
  if (!path.isAbsolute(expanded)) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      name + " must be an absolute path or start with ~/.",
    );
  }
  return path.normalize(expanded);
}

function parseIntegerEnv(value, name) {
  if (value === undefined || value === "") return undefined;
  if (!/^-?\d+$/.test(value)) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      name + " must be an integer.",
    );
  }
  return Number(value);
}

function parseBooleanEnv(value, name) {
  if (value === undefined || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new AgentDockError(
    "INVALID_CONFIG",
    name + " must be a boolean (true/false, 1/0, yes/no, on/off).",
  );
}

function parseListEnv(value) {
  if (value === undefined || value === "") return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parsePolicyEnv(value) {
  if (value === undefined || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      "AGENTDOCK_POLICY_JSON is not valid JSON: " + error.message,
    );
  }
}

function configErrorFromZod(error, configPath) {
  const details = error.issues?.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return new AgentDockError(
    "INVALID_CONFIG",
    "AgentDock configuration is invalid" +
      (configPath ? " (" + configPath + ")" : "") +
      ".",
    { issues: details },
  );
}

function defaultLayer(homeDir) {
  return {
    version: CONFIG_SCHEMA_VERSION,
    state: {
      dir: path.join(homeDir, DEFAULT_STATE_RELATIVE_PATH),
      backend: "sqlite",
      persisted_process_output_bytes:
        DEFAULT_PERSISTED_PROCESS_OUTPUT_BYTES,
    },
    execution: {
      supervisor_mode: "auto",
    },
    audit: {
      max_entries_per_task: DEFAULT_AUDIT_MAX_ENTRIES_PER_TASK,
    },
    policy: {
      rules: [],
    },
    skills: {
      matt_auto_routing: false,
      router_skill: "ask-matt",
    },
    transport: {
      mode: "stdio",
      http: {
        host: DEFAULT_HTTP_HOST,
        port: DEFAULT_HTTP_PORT,
        path: DEFAULT_HTTP_PATH,
        health_path: DEFAULT_HTTP_HEALTH_PATH,
        allowed_hosts: [...LOCAL_HOSTNAMES],
        allowed_origins: [...LOCAL_HOSTNAMES],
      },
    },
  };
}

function envLayer(env) {
  const layer = {};

  if (env.AGENTDOCK_STATE_DIR) {
    layer.state = {
      ...(layer.state ?? {}),
      dir: env.AGENTDOCK_STATE_DIR,
    };
  }

  if (env.AGENTDOCK_STATE_BACKEND) {
    layer.state = {
      ...(layer.state ?? {}),
      backend: env.AGENTDOCK_STATE_BACKEND.trim().toLowerCase(),
    };
  }

  const outputBytes = parseIntegerEnv(
    env.AGENTDOCK_PERSISTED_OUTPUT_BYTES,
    "AGENTDOCK_PERSISTED_OUTPUT_BYTES",
  );
  if (outputBytes !== undefined) {
    layer.state = {
      ...(layer.state ?? {}),
      persisted_process_output_bytes: outputBytes,
    };
  }

  if (env.AGENTDOCK_SUPERVISOR_MODE) {
    layer.execution = {
      supervisor_mode: env.AGENTDOCK_SUPERVISOR_MODE.trim().toLowerCase(),
    };
  }

  const auditMaxEntries = parseIntegerEnv(
    env.AGENTDOCK_AUDIT_MAX_ENTRIES,
    "AGENTDOCK_AUDIT_MAX_ENTRIES",
  );
  if (auditMaxEntries !== undefined) {
    layer.audit = {
      max_entries_per_task: auditMaxEntries,
    };
  }

  const policyRules = parsePolicyEnv(env.AGENTDOCK_POLICY_JSON);
  if (policyRules !== undefined) {
    layer.policy = { rules: policyRules };
  }

  const mattAutoRouting = parseBooleanEnv(
    env.AGENTDOCK_MATT_AUTO_ROUTING,
    "AGENTDOCK_MATT_AUTO_ROUTING",
  );
  if (mattAutoRouting !== undefined) {
    layer.skills = {
      ...(layer.skills ?? {}),
      matt_auto_routing: mattAutoRouting,
    };
  }

  if (env.AGENTDOCK_TRANSPORT) {
    layer.transport = {
      ...(layer.transport ?? {}),
      mode: env.AGENTDOCK_TRANSPORT,
    };
  }

  const http = {};
  if (env.AGENTDOCK_HTTP_HOST) {
    http.host = env.AGENTDOCK_HTTP_HOST;
  }

  const httpPort = parseIntegerEnv(
    env.AGENTDOCK_HTTP_PORT,
    "AGENTDOCK_HTTP_PORT",
  );
  if (httpPort !== undefined) {
    http.port = httpPort;
  }

  if (env.AGENTDOCK_HTTP_PATH) {
    http.path = env.AGENTDOCK_HTTP_PATH;
  }
  if (env.AGENTDOCK_HTTP_HEALTH_PATH) {
    http.health_path = env.AGENTDOCK_HTTP_HEALTH_PATH;
  }

  const allowedHosts = parseListEnv(env.AGENTDOCK_HTTP_ALLOWED_HOSTS);
  if (allowedHosts !== undefined) {
    http.allowed_hosts = allowedHosts;
  }
  const allowedOrigins = parseListEnv(env.AGENTDOCK_HTTP_ALLOWED_ORIGINS);
  if (allowedOrigins !== undefined) {
    http.allowed_origins = allowedOrigins;
  }

  if (Object.keys(http).length > 0) {
    layer.transport = {
      ...(layer.transport ?? {}),
      http: {
        ...(layer.transport?.http ?? {}),
        ...http,
      },
    };
  }

  return layer;
}

function readConfigFile(configPath, { explicit }) {
  if (!existsSync(configPath)) {
    if (explicit) {
      throw new AgentDockError(
        "CONFIG_NOT_FOUND",
        "AgentDock config file not found: " + configPath,
      );
    }
    return {};
  }

  let value;
  try {
    value = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      "Could not parse AgentDock config file " +
        configPath +
        ": " +
        error.message,
    );
  }

  if (!isPlainObject(value)) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      "AgentDock config file must contain a JSON object.",
    );
  }
  if (!Object.hasOwn(value, "version")) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      "AgentDock config file must declare an explicit schema version.",
    );
  }
  return value;
}

function isLoopbackHost(host) {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

export function loadAgentDockConfig({
  env = process.env,
  homeDir = os.homedir(),
  configPath,
  overrides = {},
} = {}) {
  const explicitConfigPath =
    configPath !== undefined
      ? configPath !== null
      : Boolean(env.AGENTDOCK_CONFIG);

  const selectedConfigPath =
    configPath === null
      ? null
      : absolutePath(
          configPath ??
            env.AGENTDOCK_CONFIG ??
            path.join(homeDir, DEFAULT_CONFIG_RELATIVE_PATH),
          {
            homeDir,
            name: "AgentDock config path",
          },
        );

  const fileLayer =
    selectedConfigPath === null
      ? {}
      : readConfigFile(selectedConfigPath, {
          explicit: explicitConfigPath,
        });
  const environmentLayer = envLayer(env);

  const allowedHostsExplicit =
    nestedOwn(fileLayer, ["transport", "http", "allowed_hosts"]) ||
    nestedOwn(environmentLayer, ["transport", "http", "allowed_hosts"]) ||
    nestedOwn(overrides, ["transport", "http", "allowed_hosts"]);
  const allowedOriginsExplicit =
    nestedOwn(fileLayer, ["transport", "http", "allowed_origins"]) ||
    nestedOwn(environmentLayer, ["transport", "http", "allowed_origins"]) ||
    nestedOwn(overrides, ["transport", "http", "allowed_origins"]);

  let merged = deepMerge(defaultLayer(homeDir), fileLayer);
  merged = deepMerge(merged, environmentLayer);
  merged = deepMerge(merged, overrides);

  merged.state = {
    ...merged.state,
    dir: absolutePath(merged.state.dir, {
      homeDir,
      name: "state.dir",
    }),
  };

  if (allowedHostsExplicit && !allowedOriginsExplicit) {
    merged.transport.http.allowed_origins = [
      ...merged.transport.http.allowed_hosts,
    ];
  }

  let config;
  try {
    config = AgentDockConfigSchema.parse(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw configErrorFromZod(error, selectedConfigPath);
    }
    throw error;
  }

  if (
    !isLoopbackHost(config.transport.http.host) &&
    !allowedHostsExplicit
  ) {
    throw new AgentDockError(
      "INVALID_CONFIG",
      "AGENTDOCK_HTTP_ALLOWED_HOSTS is required when HTTP binds beyond loopback (config field: transport.http.allowed_hosts).",
    );
  }

  return {
    config,
    metadata: {
      schema_version: CONFIG_SCHEMA_VERSION,
      config_path: selectedConfigPath,
      config_file_loaded:
        selectedConfigPath !== null && existsSync(selectedConfigPath),
      env_overrides: Object.keys(env)
        .filter(
          (key) =>
            CONFIG_ENV_KEYS.has(key) &&
            env[key] !== undefined &&
            env[key] !== "",
        )
        .sort(),
    },
  };
}

export function configForDisplay(config) {
  return JSON.parse(JSON.stringify(config));
}
