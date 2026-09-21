# Deployment

AgentDock MCP Harness v0.2 development builds support both stdio and native stateless Streamable HTTP. Core authentication remains an external deployment concern.

Runtime configuration is loaded from the versioned schema documented in [configuration.md](configuration.md). The default file is `~/.config/agentdock/config.json`; existing `AGENTDOCK_*` environment variables override file values.

## Local stdio

After installation, the launcher is normally:

```text
~/.local/bin/agentdock-mcp
```

A generic MCP client configuration looks like:

```json
{
  "mcpServers": {
    "agentdock": {
      "command": "/home/USER/.local/bin/agentdock-mcp",
      "env": {
        "AGENTDOCK_STATE_DIR": "/home/USER/.local/state/agentdock"
      }
    }
  }
}
```

Adjust paths for the actual account.

## Native Streamable HTTP

Development builds in the v0.2 line include a native HTTP entry point:

```bash
npm run start:http
```

Secure defaults:

```text
bind:   127.0.0.1
port:   3100
MCP:    /mcp
health: /healthz
mode:   stateless Streamable HTTP
```

The HTTP transport supports both legacy MCP clients and the MCP 2026-07-28 modern protocol era.

Environment overrides currently available before the v0.2 configuration-schema work lands:

```bash
AGENTDOCK_HTTP_HOST=127.0.0.1
AGENTDOCK_HTTP_PORT=3100
AGENTDOCK_HTTP_PATH=/mcp
AGENTDOCK_HTTP_ALLOWED_HOSTS=localhost,127.0.0.1
AGENTDOCK_HTTP_ALLOWED_ORIGINS=localhost,127.0.0.1
```

A non-loopback bind fails closed unless `AGENTDOCK_HTTP_ALLOWED_HOSTS` is explicitly set. Requests with a present Origin header are checked against the Origin allowlist; normal non-browser MCP clients that omit Origin remain supported.

The native HTTP endpoint does **not** add authentication. For remote use, keep AgentDock on loopback and put an authenticated TLS reverse proxy / MCP gateway in front of it.

## State

Default user-local state:

```text
~/.local/state/agentdock
```

It contains durable Task/process/audit state and Task worktrees.

Protect it as privileged application data.

## Remote ChatGPT deployment

AgentDock Core deliberately does not own public ingress, TLS, OAuth, DNS, or account authentication.

With native Streamable HTTP, the preferred v0.2 topology is:

```text
ChatGPT Web
   |
   | HTTPS + OAuth
   v
authenticated reverse proxy / MCP gateway
   |
   | loopback Streamable HTTP
   v
AgentDock :3100/mcp
   |
   v
Linux host
```

The existing stdio bridge topology remains supported for deployments that already use one.

The gateway should:

- require authentication;
- expose standard MCP behavior;
- use TLS;
- run AgentDock as the intended OS user;
- restart cleanly after planned and unplanned termination;
- keep authentication secrets outside the AgentDock repository.

Do not place an unauthenticated AgentDock execution endpoint on the public internet.

## Permissions

AgentDock intentionally inherits native OS permissions.

If the AgentDock OS user can read/write a host path or run a command, AgentDock can do so when instructed through its public primitives.

For higher isolation, use a dedicated Linux account, VM, container, or other OS boundary. Do not assume AgentDock itself is a sandbox.

## Git repositories

Formal write-capable Tasks require a Git repository.

Task creation:

1. records current source `HEAD`;
2. creates an isolated worktree;
3. does not import dirty source changes;
4. keeps source working-tree edits separate.

## Policy

Policy rules belong in `policy.rules` in the versioned AgentDock config.

Example:

```json
{
  "version": 1,
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
  }
}
```

`AGENTDOCK_POLICY_JSON` remains supported as a higher-precedence deployment override and replaces the complete file rule array.

Rules are deterministic. They do not invoke an AI model.

## Production checklist

- [ ] dedicated OS user or explicitly accepted user permissions
- [ ] private state directory
- [ ] authenticated TLS endpoint
- [ ] deterministic policy reviewed
- [ ] service restart policy tested
- [ ] MCP reconnect tested
- [ ] source repositories backed up normally
- [ ] secrets not stored in repository
- [ ] dependency/security updates monitored
