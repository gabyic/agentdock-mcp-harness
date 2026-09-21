# Deployment

AgentDock MCP Harness v0.1 is a deterministic MCP server running over stdio.

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

## State

Default user-local state:

```text
~/.local/state/agentdock
```

It contains durable Task/process/audit state and Task worktrees.

Protect it as privileged application data.

## Remote ChatGPT deployment

v0.1 deliberately does not own public ingress, TLS, OAuth, DNS, or reverse-proxy configuration.

A production remote topology is:

```text
ChatGPT Web
   |
   | HTTPS + OAuth
   v
authenticated MCP gateway
   |
   | stdio bridge
   v
AgentDock Core
   |
   v
Linux host
```

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

Policy configuration is supplied through `AGENTDOCK_POLICY_JSON` in v0.1.

Example:

```bash
export AGENTDOCK_POLICY_JSON='[
  {
    "id": "ask-service-restart",
    "effect": "ask",
    "tool": "process.start",
    "shell_regex": "^systemctl restart ",
    "approval_scope": "service-restart"
  }
]'
```

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
