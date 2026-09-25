# Deployment

AgentDock is an execution harness. It deliberately keeps public ingress, TLS, OAuth, DNS, and account authentication outside Core.

This guide takes a fresh Linux host from source checkout to a working remote MCP connection. For ChatGPT, the recommended path is to keep AgentDock private on loopback and use OpenAI Secure MCP Tunnel when your account/workspace supports it. If you already operate an authenticated OAuth-capable MCP gateway, you can place that gateway in front of AgentDock instead.

> **Do not expose an unauthenticated AgentDock MCP endpoint directly to the public internet.** AgentDock can execute commands and access host paths permitted to its OS user.

## Deployment paths

Choose one path:

| Path | AgentDock listener | Internet exposure | Best for |
| --- | --- | --- | --- |
| Local stdio | none | none | local MCP clients |
| Private HTTP + Secure MCP Tunnel | `127.0.0.1:3100` | outbound HTTPS only | ChatGPT / supported OpenAI products |
| Private HTTP + external OAuth MCP gateway | `127.0.0.1:3100` | gateway only | self-managed production ingress |

The same AgentDock Core is used in all three cases.

## Prerequisites

- Linux
- Node.js 24 or newer
- npm
- Git
- a non-root OS account for AgentDock
- systemd user services if you want to use the shipped service unit

Check the basics:

```bash
node --version
npm --version
git --version
```

## 1. Install AgentDock

Clone the repository and run the managed installer:

```bash
git clone https://github.com/gabyic/agentdock-mcp-harness.git
cd agentdock-mcp-harness
./scripts/install.sh
```

The default installation is user-local:

```text
program: ~/.local/share/agentdock-mcp-harness
CLI:     ~/.local/bin/agentdock
MCP:     ~/.local/bin/agentdock-mcp
state:   ~/.local/state/agentdock
config:  ~/.config/agentdock/config.json
```

If `~/.local/bin` is not already on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Run the environment checks:

```bash
agentdock doctor
```

For machine-readable diagnostics:

```bash
agentdock doctor --json
```

Do not continue to remote exposure until `doctor` is clean enough for your intended deployment.

## 2. Start the native HTTP MCP service

For remote use, AgentDock should normally listen only on loopback.

Install the shipped user service:

```bash
mkdir -p ~/.config/systemd/user
cp ~/.local/share/agentdock-mcp-harness/deploy/systemd/agentdock-supervisor.service \
  ~/.config/systemd/user/agentdock-supervisor.service
cp ~/.local/share/agentdock-mcp-harness/deploy/systemd/agentdock-http.service \
  ~/.config/systemd/user/agentdock-http.service

systemctl --user daemon-reload
systemctl --user enable --now agentdock-supervisor.service agentdock-http.service
```

Verify it:

```bash
systemctl --user status agentdock-supervisor.service agentdock-http.service
agentdock health
```

Expected endpoints:

```text
MCP:    http://127.0.0.1:3100/mcp
health: http://127.0.0.1:3100/healthz
```

A healthy result looks like:

```text
[PASS] health — AgentDock is healthy.
```

If this Linux account must keep the user service running after logout, the host administrator may need to enable lingering:

```bash
sudo loginctl enable-linger "$USER"
```

That is an OS/systemd decision, not an AgentDock requirement.

### Optional service overrides

The shipped unit loads this file when present:

```text
~/.config/agentdock/service.env
```

Example:

```bash
mkdir -p ~/.config/agentdock
cat > ~/.config/agentdock/service.env <<'EOF'
AGENTDOCK_HTTP_HOST=127.0.0.1
AGENTDOCK_HTTP_PORT=3100
EOF
chmod 600 ~/.config/agentdock/service.env

systemctl --user restart agentdock-http.service
agentdock health
```

Keep secrets out of the repository. See [configuration.md](configuration.md) for the canonical configuration schema and precedence rules.

## 3A. Recommended for ChatGPT: Secure MCP Tunnel

OpenAI Secure MCP Tunnel lets supported OpenAI products reach a private MCP server without opening an inbound firewall port. The tunnel client runs beside AgentDock and initiates outbound HTTPS to OpenAI.

Official documentation:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

The AgentDock-specific local MCP URL is:

```text
http://127.0.0.1:3100/mcp
```

High-level setup:

1. Create an MCP tunnel in the OpenAI Platform tunnel settings.
2. Install the current `tunnel-client` release using the instructions in the OpenAI tunnel documentation.
3. Configure the tunnel profile to forward to `http://127.0.0.1:3100/mcp`.
4. Validate the profile with `tunnel-client doctor`.
5. Keep `tunnel-client run` supervised.
6. In ChatGPT Developer Mode, create an app using **Tunnel** as the connection type and select that tunnel.

A typical tunnel-client flow is:

```bash
export CONTROL_PLANE_API_KEY="YOUR_OPENAI_RUNTIME_KEY"

# Follow the current OpenAI quickstart when creating the profile.
# The AgentDock target should be:
#   --mcp-server-url http://127.0.0.1:3100/mcp

tunnel-client doctor --profile agentdock --explain
tunnel-client run --profile agentdock
```

The exact tunnel provisioning flags are owned by OpenAI and may evolve, so use the current official tunnel quickstart rather than copying a stale binary version or hard-coded download URL from this repository.

### Why this is the recommended path

```text
ChatGPT
   |
   | OpenAI-hosted tunnel endpoint
   v
outbound Secure MCP Tunnel
   |
   v
tunnel-client on your Linux host
   |
   | loopback
   v
AgentDock 127.0.0.1:3100/mcp
```

AgentDock never needs a public listening socket.

## 3B. Alternative: authenticated HTTPS/OAuth MCP gateway

If Secure MCP Tunnel is not appropriate and you already operate an OAuth-capable MCP gateway, use this topology:

```text
ChatGPT / remote MCP client
   |
   | HTTPS + authentication
   v
OAuth-capable MCP gateway
   |
   | private / loopback HTTP
   v
AgentDock 127.0.0.1:3100/mcp
```

The gateway is responsible for:

- TLS certificates;
- authentication and OAuth/OIDC behavior required by the client;
- public DNS;
- request limits and abuse protection;
- forwarding MCP requests to AgentDock;
- keeping credentials outside the AgentDock repository.

AgentDock does not ship an OAuth provider or public-ingress stack.

A plain Nginx/Caddy reverse proxy that only adds TLS is **not** sufficient protection for an execution endpoint unless authentication is also enforced.

Do not change AgentDock to `0.0.0.0` merely to make remote access convenient. Keep Core on loopback unless you have explicitly designed and reviewed the network boundary.

## 4. Connect from ChatGPT

ChatGPT's MCP/App UI changes over time. Use the current OpenAI Developer Mode documentation as the source of truth:

https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

At the time this guide was updated (September 2026), the flow is generally:

1. Enable Developer Mode for the eligible ChatGPT workspace/account.
2. Open **Settings → Apps → Create**.
3. Choose the connection type:
   - **Tunnel** for Secure MCP Tunnel; or
   - remote MCP endpoint for your authenticated public gateway.
4. Complete authentication if prompted.
5. Click **Scan Tools**.
6. Review the discovered AgentDock tools.
7. Create/enable the app.
8. Start a new chat and select or mention the AgentDock app.

OpenAI plan/workspace support for full MCP write/modify actions is product-dependent and changes over time. Check the current OpenAI documentation before troubleshooting AgentDock itself.

### Refresh tools after an AgentDock upgrade

ChatGPT keeps a reviewed snapshot of an app's tools. New or changed AgentDock tools are not necessarily enabled automatically.

After upgrading AgentDock or adding tools such as `run.start`, `run.get`, or `skill.invoke`:

1. open the AgentDock app/connector settings in ChatGPT;
2. choose **Refresh** / rescan tools;
3. review the tool diff;
4. enable or publish the updated actions as appropriate for the workspace.

If the server clearly exposes a tool but ChatGPT does not show it, refresh the app before debugging AgentDock.

## 5. End-to-end smoke test

First verify the service locally:

```bash
agentdock health
```

Then test from the MCP client:

1. inspect a repository;
2. create a Workspace Task;
3. start a short Run;
4. read it through bounded `run.get`;
5. cancel/finish/cleanup the test Task.

For example, from ChatGPT:

```text
Use AgentDock to inspect /path/to/repo.
Create an isolated task, run "git status --short", show me the result,
then clean up the task. Do not modify the repository.
```

A deployment is not considered complete merely because the systemd service is `active`. Confirm an actual MCP tool call reaches AgentDock and returns a result.

## 6. Verify after upgrades

Upgrade from another checked-out/release source with:

```bash
agentdock upgrade --source /path/to/new-agentdock
```

Then:

```bash
systemctl --user restart agentdock-supervisor.service
systemctl --user restart agentdock-http.service
agentdock doctor
agentdock health
```

Supervisor must be healthy before the HTTP and MCP/OAuth clients. For a state migration or worktree reclamation, follow [production cutover and GC](production-cutover-and-gc.md) instead of doing an online restart.

Finally refresh the ChatGPT app tool definitions if the MCP tool surface changed.

## 7. Troubleshooting

### `agentdock: command not found`

Add the default launcher directory:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Service is not running

```bash
systemctl --user status agentdock-http.service
journalctl --user -u agentdock-http.service -n 200 --no-pager
```

### Health check fails

```bash
agentdock health --url http://127.0.0.1:3100/healthz
```

Confirm the configured host/port in:

```text
~/.config/agentdock/config.json
~/.config/agentdock/service.env
```

### ChatGPT cannot discover tools

Check in this order:

1. `agentdock health` is green;
2. the tunnel/gateway can reach `http://127.0.0.1:3100/mcp`;
3. tunnel/gateway authentication is valid;
4. ChatGPT Developer Mode/app permissions are enabled;
5. **Scan Tools / Refresh** has been run after the latest AgentDock update.

### A long command appears stuck

Prefer the Run interface:

```text
run.start
run.get
run.cancel
```

`run.get` returns bounded output and may long-poll for at most 10 seconds. A period with no new stdout does not by itself mean the process is stuck.

`task.resume` returns a compact status summary with `activity_state`, `current_blocker`, `last_meaningful_progress_at`, and `recommended_next_action`, so the caller can distinguish real execution, verification, approvals, reasoning barriers, interruption, and commit/finish readiness. Reading the status does not manufacture Task or audit progress.

### Another runtime reports remote ownership

Current AgentDock releases record an execution-owner lease. A second live AgentDock runtime may observe a Run as remotely owned without rewriting it to `INTERRUPTED`.

If the owner heartbeat becomes stale while its PID is still alive, AgentDock reports the stale lease instead of corrupting Run state. `INTERRUPTED` is reserved for lost execution ownership.

## Local stdio MCP

For clients running on the same host, no HTTP service is required.

The installed launcher is:

```text
~/.local/bin/agentdock-mcp
```

Generic MCP client configuration:

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

## Security checklist

Before treating the deployment as production-ready:

- [ ] AgentDock runs as an intentional non-root OS user.
- [ ] `~/.local/state/agentdock` is private.
- [ ] AgentDock HTTP remains on loopback/private networking.
- [ ] Remote access uses Secure MCP Tunnel or authenticated HTTPS/OAuth ingress.
- [ ] No unauthenticated execution endpoint is public.
- [ ] Deterministic policy rules were reviewed.
- [ ] Service restart behavior was tested.
- [ ] MCP reconnect was tested.
- [ ] ChatGPT tool discovery was refreshed after upgrades.
- [ ] Source repositories are backed up normally.
- [ ] Secrets are not stored in the repository.

## Related documentation

- [configuration.md](configuration.md)
- [doctor.md](doctor.md)
- [lifecycle.md](lifecycle.md)
- [service-lifecycle.md](service-lifecycle.md)
- [guided-development.md](guided-development.md)
- [releasing.md](releasing.md)
