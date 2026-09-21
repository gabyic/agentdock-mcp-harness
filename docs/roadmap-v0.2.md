# AgentDock MCP Harness v0.2 Roadmap

Status: PLANNED

## Objective

v0.2 is a productionization and protocol-modernization release.

The goal is not to turn AgentDock into another autonomous agent framework. The connected MCP client remains the reasoning agent; AgentDock remains a deterministic execution harness.

## P0 — Protocol and transport modernization

### 1. Migrate to MCP 2026-07-28 / TypeScript SDK v2 — DONE

Completed in v0.2-01:

- runtime migrated from `@modelcontextprotocol/sdk` v1 to `@modelcontextprotocol/server@2.0.0`;
- black-box clients migrated to `@modelcontextprotocol/client@2.0.0`;
- tool registration migrated to `registerTool()` with explicit Zod v4 schemas;
- stdio serving migrated to `serveStdio(factory)`;
- the full v0.1 Acceptance is pinned to the 2026-07-28 modern protocol era;
- a dedicated regression test proves the same 19-tool surface is served to both legacy and modern clients;
- the full black-box suite remains green;
- no server-side LLM dependency was introduced.

### 2. Native Streamable HTTP adapter — DONE

Completed in v0.2-02:

- stdio remains a first-class transport;
- native Node.js Streamable HTTP is available through `npm run start:http`;
- the HTTP endpoint uses the SDK v2 `createMcpHandler(factory)` per-request model and the official `@modelcontextprotocol/node` adapter;
- modern MCP 2026-07-28 and legacy clients share the same 19-tool surface;
- transport requests are stateless, while AgentDock Task/Process/Approval/Audit services share one process runtime;
- asynchronous process ownership remains correct across separate HTTP requests;
- HTTP binds to `127.0.0.1:3100` by default;
- Host and Origin guards are enabled by default, and non-loopback binds require an explicit host allowlist;
- `/healthz` provides a non-MCP process health endpoint;
- HTTP transport contains no Git/file/process business logic.

Authentication remains a deployment boundary rather than a hidden Core dependency.

## P0 — Distribution and operations

### 3. Stable configuration schema — DONE

Completed in v0.2-03:

- added versioned JSON config schema v1 at `~/.config/agentdock/config.json`;
- added explicit `AGENTDOCK_CONFIG` file selection;
- froze precedence as defaults < config file < environment < programmatic overrides;
- centralized state, policy, persisted process-output limit, audit retention, transport selection and HTTP settings;
- preserved all existing `AGENTDOCK_*` deployment overrides;
- wired configurable process snapshot limits into StateStore;
- wired bounded per-Task audit retention with explicit truncation metadata;
- made `npm start` follow `transport.mode`;
- kept `npm run start:http` as an explicit HTTP override;
- rejected unknown fields, invalid regex/types/ports/paths, and unsafe non-loopback HTTP configuration;
- documented the schema and environment mapping in `docs/configuration.md`.

### 4. `agentdock doctor` — DONE

Completed in v0.2-04:

- added installed `agentdock` CLI with `doctor`, `--json`, and `--config PATH`;
- reports Node.js and Git availability/version;
- performs a real disposable Git detached-worktree create/list/remove probe;
- verifies the configured state directory with a write/fsync/delete probe;
- reports stdio or HTTP transport configuration;
- validates policy through the canonical v0.2 config loader;
- reports the effective OS user/uid/gid;
- probes passwordless sudo with `sudo -n true` while treating sudo as optional;
- distinguishes PASS / WARN / FAIL and uses exit 1 only for FAIL;
- avoids printing policy bodies, environment values, tokens, passwords or API credentials;
- added machine-readable JSON output and dedicated black-box CLI coverage.

### 5. Install / upgrade / uninstall lifecycle

Provide:

- user-local install;
- versioned upgrade path;
- uninstall that leaves Task state alone by default;
- explicit state removal option;
- reproducible release artifacts.

The installation path must not silently expose AgentDock to the network.

### 6. Service lifecycle hardening

The live v0.1 acceptance exposed a real operational issue: a clean SIGTERM with `Restart=on-failure` did not restart the remote connector.

v0.2 should define and test deployment expectations for:

- deliberate restart;
- unexpected crash;
- graceful shutdown;
- process ownership;
- service health checks;
- connector recovery.

## P0 — Open-source release engineering

### 7. CI

Required CI gates:

- Node 24;
- `npm ci`;
- full MCP black-box test suite;
- v0.1 acceptance scenario;
- dependency audit;
- basic package metadata validation.

### 8. Versioning and release

Adopt SemVer and tagged GitHub releases.

Initial public sequence:

- `v0.1.0`: proven Linux Core;
- `v0.2.0`: productionized MCP v2 / HTTP release.

Do not publish an npm package until the package name and CLI surface are stable.

## P1 — Operator usability

### 9. Read-only Task discovery

Add deterministic operator primitives such as:

- `task.list`;
- Task summary by state;
- process summary;
- state-directory diagnostics.

Do not add a scheduler in v0.2.

### 10. Policy configuration ergonomics

Keep the policy engine deterministic while improving:

- configuration validation;
- rule explanation;
- dry-run evaluation;
- examples for common safe/ask/deny boundaries.

No AI risk engine.

### 11. Audit retention

Add bounded retention controls for:

- operation entries;
- persisted process diagnostics;
- completed Task metadata.

Retention must never make live responses less faithful.

## Explicitly deferred beyond v0.2

- macOS execution backend;
- Windows execution backend;
- Gateway/Node fleet architecture;
- autonomous Codex / Claude / OpenCode workers;
- server-side LLM inference;
- browser / desktop automation;
- Kubernetes orchestration;
- multi-tenant SaaS;
- RBAC / billing / organizations;
- universal rollback for arbitrary host effects.

## Exit criteria

v0.2 is complete when:

1. the MCP v2 migration passes the entire v0.1 behavior suite;
2. stdio and native Streamable HTTP both pass black-box acceptance;
3. install / upgrade / doctor are reproducible on a clean Linux host;
4. remote restart/reconnect behavior is automated in CI or an equivalent integration harness;
5. public documentation matches actual security and permission semantics;
6. no second model or AI API key is required by Core.
