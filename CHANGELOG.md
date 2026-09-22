# Changelog

All notable changes to AgentDock MCP Harness will be documented here.

The project follows Semantic Versioning.

## [Unreleased]

## [0.2.0-rc.1] - 2026-09-22

### Added

- Unified release gate covering version/metadata consistency, full tests, v0.1 acceptance, production dependency audit, systemd contract verification, reproducible artifacts, extracted-install smoke testing and health/graceful-shutdown validation.
- Tag-driven GitHub Release workflow that verifies the tag/version pair and publishes signed-off release artifacts plus SHA-256 checksums without publishing to npm.
- Hardened service lifecycle with graceful owned-Process shutdown, health probing/retry, systemd `Restart=always` + `KillMode=control-group` contract, and restart/crash recovery tests.
- `agentdock health` CLI for local/explicit HTTP health checks and startup readiness gates.
- Managed install/upgrade/uninstall lifecycle with version manifests, downgrade protection, state-preserving uninstall defaults, and explicit destructive cleanup options.
- Reproducible versioned release tarballs with SHA-256 checksum generation.
- `agentdock doctor` CLI with human-readable and JSON diagnostics for runtime, Git/worktree support, configuration, state persistence, transport, policy, OS user and optional sudo.
- Versioned JSON configuration schema v1 with `~/.config/agentdock/config.json` discovery and `AGENTDOCK_CONFIG` override.
- Configurable persisted process-output bounds and bounded per-Task audit retention with truncation metadata.
- Native stateless Streamable HTTP transport for MCP on `/mcp`, while retaining stdio.
- Loopback-only HTTP defaults, Host/Origin validation, and a `/healthz` endpoint.
- Shared AgentDock runtime across per-request HTTP MCP server instances so asynchronous process ownership survives separate HTTP requests.
- Black-box HTTP coverage for both legacy and MCP 2026-07-28 clients, including process lifecycle and DNS-rebinding guards.

### Changed

- Migrated Core from the monolithic `@modelcontextprotocol/sdk` v1 package to the stable split MCP TypeScript SDK v2 packages.
- Replaced deprecated `server.tool()` registration with v2 `registerTool()` and explicit Zod v4 Standard Schema objects.
- Replaced hand-wired stdio serving with `serveStdio(factory)`, enabling MCP 2026-07-28 modern-era connections while preserving 2025-era compatibility.
- Moved the MCP client SDK used by black-box tests to a development-only dependency.
- Pinned the full v0.1 acceptance scenario to MCP 2026-07-28 and added dual-era tool-surface regression coverage.

## [0.1.0] - 2026-09-21

### Added

- Git-native durable Task lifecycle.
- Isolated worktree creation from source repository HEAD.
- Deterministic file read/search/patch/write primitives.
- Asynchronous process lifecycle with incremental output cursors.
- Durable Task/process state across MCP reconnects and AgentDock restarts.
- Deterministic allow/ask/deny policy.
- Smart Approval protocol with ALLOW_ONCE, ALLOW_TASK, DENY and ASK_USER.
- Real local Git commits.
- Explicit finish, cancel and cleanup semantics.
- Host absolute-path access using native OS permissions.
- Structured Task audit with best-effort secret redaction.
- Bounded persisted process diagnostics.
- Automated MCP black-box acceptance.
- Live ChatGPT Web acceptance on a real Linux host.

### Proven v0.1 acceptance

The live acceptance demonstrated:

- targeted test FAIL;
- failure-driven second edit;
- real MCP service interruption;
- durable task.resume;
- real Smart Approval round-trip;
- targeted and full test PASS;
- real Git commit;
- task.finish;
- audit evidence;
- source repository zero pollution.

### Known limitations

- Linux only.
- stdio Core transport only.
- Public ingress/authentication are external deployment concerns.
- No first-class push/merge/PR/deploy orchestration.
- No server-side LLM or autonomous worker.
