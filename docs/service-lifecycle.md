# Service Lifecycle Hardening

AgentDock v0.2 defines explicit service lifecycle semantics for long-running Linux deployments.

The recommended production shape for Core is native Streamable HTTP on loopback, supervised by systemd, with authenticated TLS ingress in front.

## Why this exists

The live v0.1 acceptance found a real operational failure mode:

```text
Restart=on-failure
+
clean SIGTERM
=
service exits successfully
=
systemd does not restart it
```

v0.2 fixes that contract instead of treating reconnect as an application-only problem.

## Service state contract

### Planned shutdown / restart

Examples:

```bash
systemctl --user restart agentdock-http.service
kill -TERM <agentdock-main-pid>
```

When AgentDock receives SIGTERM or SIGINT:

1. HTTP stops accepting new requests;
2. AgentDock terminates Process groups it currently owns;
3. those Process records become `CANCELLED`;
4. transports close;
5. AgentDock exits successfully.

The audit contains a `PROCESS_CANCEL_REQUESTED` entry with:

```text
reason=service_shutdown
```

A subsequent AgentDock instance can resume the durable Task without pretending those Processes are still running.

### Unexpected crash

Examples include:

- SIGKILL;
- runtime crash;
- OOM termination;
- host/service-manager interruption before AgentDock can run cleanup.

There is no application-level cleanup opportunity.

The hardened systemd unit uses:

```ini
KillMode=control-group
```

so detached Task subprocesses remain in the service cgroup and are cleaned with the failed service.

On the next AgentDock instance, persisted Process records that were still `RUNNING` or `CANCELLING` are restored as:

```text
INTERRUPTED
```

with the existing durable reason:

```text
AgentDock restarted or lost ownership of the running process.
```

This distinction is deliberate:

```text
CANCELLED   = AgentDock intentionally terminated a Process.
INTERRUPTED = AgentDock lost ownership unexpectedly.
```

## Health command

For HTTP deployments:

```bash
agentdock health
```

Explicit endpoint:

```bash
agentdock health --url http://127.0.0.1:3100/healthz
```

Machine-readable:

```bash
agentdock health --json
```

Startup/recovery gate:

```bash
agentdock health --wait-ms 10000 --timeout-ms 1000
```

`--wait-ms` retries until the endpoint becomes healthy or the deadline expires.

Exit codes:

- `0`: healthy;
- `1`: unhealthy / configuration error;
- `2`: CLI usage error.

The health check requires the endpoint to return HTTP success with:

```json
{
  "status": "ok",
  "transport": "streamable-http"
}
```

## Hardened systemd user unit

The repository ships:

```text
deploy/systemd/agentdock-http.service
```

The contract is automatically validated by:

```bash
npm run service:verify
```

Critical properties:

```ini
Environment=AGENTDOCK_TRANSPORT=http
Restart=always
RestartSec=2
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
FinalKillSignal=SIGKILL
TimeoutStopSec=15
UMask=0077
```

Startup is gated by:

```ini
ExecStartPost=%h/.local/bin/agentdock health --wait-ms 10000 --timeout-ms 1000
```

### Why `Restart=always`

It restarts AgentDock after both abnormal failure and a clean direct SIGTERM.

An explicit `systemctl --user stop ...` is still an operator stop request; systemd does not treat that as a reason to immediately restart the unit.

### Why `KillMode=control-group`

AgentDock Process execution intentionally uses detached Unix process groups. Detached does not remove those descendants from the systemd service cgroup.

`KillMode=control-group` makes the service manager responsible for cleaning all remaining descendants when the service stops/crashes.

Do not change this to `process` or `none`.

## Install the user unit

For a default managed installation:

```bash
mkdir -p ~/.config/systemd/user
cp ~/.local/share/agentdock-mcp-harness/deploy/systemd/agentdock-http.service \
  ~/.config/systemd/user/agentdock-http.service

systemctl --user daemon-reload
systemctl --user enable --now agentdock-http.service
```

Check:

```bash
systemctl --user status agentdock-http.service
agentdock health
```

If your launchers are not in `~/.local/bin`, edit `ExecStart` and `ExecStartPost` accordingly.

To keep a user service running after logout, the host may require user lingering to be enabled by the operator/administrator.

## Optional service environment overrides

The unit loads this file if present:

```text
~/.config/agentdock/service.env
```

Example:

```bash
AGENTDOCK_HTTP_PORT=3100
AGENTDOCK_HTTP_HOST=127.0.0.1
```

Do not put secrets in a world-readable file. Normal AgentDock config/env precedence still applies.

## Test contract

v0.2-06 black-box coverage verifies:

- planned SIGTERM exits cleanly;
- owned Task Process is actually terminated;
- planned Process state restores as `CANCELLED`;
- audit records `reason=service_shutdown`;
- health endpoint goes down and comes back;
- a new MCP client can reconnect and list all tools;
- hard crash recovery restores lost Process ownership as `INTERRUPTED`;
- the systemd unit cannot regress to `Restart=on-failure`;
- the systemd unit keeps `KillMode=control-group`;
- the startup health gate retries while the service is still coming up.

## Existing reverse proxy / OAuth deployments

AgentDock Core does not replace OAuth/TLS ingress.

If an external MCP/OAuth proxy owns the public socket, supervise that proxy separately and ensure its own restart policy is correct.

The native HTTP systemd unit covers the recommended Core process itself.
