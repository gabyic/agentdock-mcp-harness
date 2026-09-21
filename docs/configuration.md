# Configuration

AgentDock v0.2 uses a versioned JSON configuration schema.

## Default location

```text
~/.config/agentdock/config.json
```

If the default file does not exist, AgentDock uses built-in defaults.

To use a specific file:

```bash
export AGENTDOCK_CONFIG=/absolute/path/to/config.json
```

An explicitly requested config file must exist. Relative config paths are rejected. `~/...` is supported.

## Precedence

Configuration is resolved in this order:

```text
built-in defaults
  < config.json
  < AGENTDOCK_* environment variables
  < programmatic overrides
```

Later layers replace earlier layers.

This preserves existing environment-based deployments while making the file schema the canonical configuration surface.

## Schema version 1

When a config file exists, it must explicitly declare `"version": 1`. Files without a schema version are rejected.

Example:

```json
{
  "version": 1,
  "state": {
    "dir": "~/.local/state/agentdock",
    "persisted_process_output_bytes": 65536
  },
  "audit": {
    "max_entries_per_task": 5000
  },
  "policy": {
    "rules": [
      {
        "id": "ask-service-restart",
        "effect": "ask",
        "tool": "process.start",
        "shell_regex": "^systemctl restart ",
        "approval_scope": "service-restart"
      }
    ]
  },
  "transport": {
    "mode": "stdio",
    "http": {
      "host": "127.0.0.1",
      "port": 3100,
      "path": "/mcp",
      "health_path": "/healthz",
      "allowed_hosts": [
        "localhost",
        "127.0.0.1",
        "[::1]"
      ],
      "allowed_origins": [
        "localhost",
        "127.0.0.1",
        "[::1]"
      ]
    }
  }
}
```

Unknown fields are rejected.

## State

### `state.dir`

Durable Task, process, audit and worktree state.

Requirements:

- absolute path, or
- a path beginning with `~/`.

Default:

```text
~/.local/state/agentdock
```

### `state.persisted_process_output_bytes`

Maximum diagnostic process-output bytes persisted per Process snapshot.

Live process output remains faithful while AgentDock owns the Process. This setting only bounds the durable diagnostic snapshot.

Default:

```text
65536
```

Range:

```text
1024 .. 67108864
```

## Audit

### `audit.max_entries_per_task`

Maximum structured audit entries retained per Task.

Default:

```text
5000
```

When older entries are removed, `audit.get` reports:

- `retained_from_sequence`
- `truncated_before_sequence=true`

so callers do not mistake retained history for complete history.

## Policy

`policy.rules` is the canonical deterministic approval-policy array.

Supported effects:

- `allow`
- `ask`
- `deny`

Rule fields:

- `id`
- `effect`
- `tool`
- optional `approval_scope`
- optional `shell_regex`
- optional `argv_prefix`

Invalid regular expressions fail configuration validation before AgentDock starts.

Example:

```json
{
  "id": "ask-deploy",
  "effect": "ask",
  "tool": "process.start",
  "argv_prefix": ["systemctl", "restart"],
  "approval_scope": "service-restart"
}
```

## Transport

### `transport.mode`

Supported values:

- `stdio`
- `http`

Default:

```text
stdio
```

`npm start` follows this value.

`npm run start:http` explicitly selects HTTP for that process.

### HTTP

Defaults:

```text
host:        127.0.0.1
port:        3100
path:        /mcp
health_path: /healthz
```

For loopback, the default allowed host/origin names are:

```text
localhost
127.0.0.1
[::1]
```

If HTTP binds beyond loopback, `allowed_hosts` must be explicitly configured. AgentDock fails closed otherwise.

If `allowed_hosts` is explicitly configured but `allowed_origins` is omitted, allowed origins inherit the allowed-host list.

Authentication is not part of this schema. Put authenticated TLS ingress / OAuth in front of AgentDock for remote exposure.

## Environment compatibility

Existing environment variables remain supported and override the file.

| Environment variable | Config field |
| --- | --- |
| `AGENTDOCK_CONFIG` | selects config file |
| `AGENTDOCK_STATE_DIR` | `state.dir` |
| `AGENTDOCK_PERSISTED_OUTPUT_BYTES` | `state.persisted_process_output_bytes` |
| `AGENTDOCK_AUDIT_MAX_ENTRIES` | `audit.max_entries_per_task` |
| `AGENTDOCK_POLICY_JSON` | `policy.rules` |
| `AGENTDOCK_TRANSPORT` | `transport.mode` |
| `AGENTDOCK_HTTP_HOST` | `transport.http.host` |
| `AGENTDOCK_HTTP_PORT` | `transport.http.port` |
| `AGENTDOCK_HTTP_PATH` | `transport.http.path` |
| `AGENTDOCK_HTTP_HEALTH_PATH` | `transport.http.health_path` |
| `AGENTDOCK_HTTP_ALLOWED_HOSTS` | `transport.http.allowed_hosts` |
| `AGENTDOCK_HTTP_ALLOWED_ORIGINS` | `transport.http.allowed_origins` |

Host/origin environment lists are comma-separated.

Example:

```bash
export AGENTDOCK_HTTP_ALLOWED_HOSTS="agentdock.example.com,localhost"
```

`AGENTDOCK_POLICY_JSON` remains a JSON array and replaces the file's complete policy-rule array.

## Installer interaction

The default user-local installer no longer injects `AGENTDOCK_STATE_DIR` into every launcher process. This allows `state.dir` in `config.json` to take effect.

If the installer is given an explicit `--state-dir` (or `AGENTDOCK_STATE_DIR` is explicitly set while installing), the generated launcher preserves that deployment choice as an environment override.

## Failure behavior

AgentDock fails before serving MCP when configuration is invalid.

Examples:

- malformed JSON;
- unsupported schema version;
- unknown fields;
- invalid field types;
- invalid policy regex;
- invalid port or retention limit;
- relative state/config paths;
- non-loopback HTTP bind without an explicit host allowlist.

Configuration errors never silently fall back to guessed values.

Validate the effective configuration and surrounding runtime with:

```bash
agentdock doctor
```

Use `agentdock doctor --json` for machine-readable diagnostics. See [doctor.md](doctor.md).
