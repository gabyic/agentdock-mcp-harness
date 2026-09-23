# Changelog

All notable changes to AgentDock MCP Harness will be documented here.

The project follows Semantic Versioning.

## [Unreleased]

## [0.3.0-dev.3] - 2026-09-23

### Added

- Auto Matt routing through the existing `skill.invoke` tool using `skill_name="auto"`, so the MCP tool surface remains stable at 31 tools.
- `AGENTDOCK_MATT_AUTO_ROUTING` / `skills.matt_auto_routing` as an explicit, default-off authorization for model-selected upstream user-invoked Skills.
- Routing packets containing the installed Ask Matt instructions, installed Skill candidates, and durable workflow context for chat-side selection.
- `agentdock doctor` visibility for the effective Matt auto-routing mode and router Skill.

### Changed

- User-invoked upstream Skills remain fail-closed by default, but when Auto Matt has been explicitly enabled their model-side invocation is admitted and recorded as `auto_authorized`.
- `workflow.guide` now directs the chat model into `skill.invoke` for the recommended Skill instead of treating Skill reading as an informal convention.

### Safety

- Auto Matt does not add a server-side LLM, automatic product decisions, approval bypass, or workflow-boundary bypass.

## [0.3.0-dev.2] - 2026-09-23

### Added

- `skill.invoke`, a stable chat-facing gateway that returns installed Skill instructions and provenance for chat-side reasoning while keeping server-side LLM execution disabled.
- Enforcement of user-invoked Skill semantics: Skills declaring `disable-model-invocation: true` fail closed unless the caller marks the invocation as explicitly user-triggered.
- Optional durable workflow context on `skill.invoke` when a repository path is supplied.
- `workflow.status`, a read-only App-facing alias for current guided-development state and the recommended next Skill.

### Changed

- Clarified the v0.3 product boundary: one `@AgentDock` MCP/App owns both the deterministic execution harness and the internal Matt-style Skill/Guided Workflow layer; no second Matt MCP is required.

## [0.3.0-dev.1] - 2026-09-22

### Added

- v0.3 Guided Development preview: Git-backed server-side Skill resources (`skill.install/update/list/search/read`) and durable project workflow guidance (`workflow.start/list/update/guide/advance`) for chat surfaces that cannot invoke installed Skills natively.
- Matt Pocock engineering-flow compatibility with first-use setup, grilling, wayfinding, prototype detours, spec/ticket routing, implementation/review boundaries, source commit evidence, cross-chat recovery, and fail-closed unresolved-decision guards.

## [0.2.0] - 2026-09-22

### Stable promotion

- Promoted the validated `v0.2.0-rc.1` productionization line to stable after green main CI, green release gate, verified release archive/checksum, installed production health checks, and restart smoke evidence.
- No v0.3 Guided Development functionality is included in this stable release.

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
