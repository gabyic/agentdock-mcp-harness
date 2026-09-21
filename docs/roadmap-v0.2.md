# AgentDock MCP Harness v0.2 Roadmap

Status: PLANNED

## Objective

v0.2 is a productionization and protocol-modernization release.

The goal is not to turn AgentDock into another autonomous agent framework. The connected MCP client remains the reasoning agent; AgentDock remains a deterministic execution harness.

## P0 — Protocol and transport modernization

### 1. Migrate to MCP 2026-07-28 / TypeScript SDK v2

The current v0.1 implementation uses the v1 monolithic `@modelcontextprotocol/sdk` package.

v0.2 will migrate to the stable split SDK:

- `@modelcontextprotocol/server`
- Zod v4 schemas
- the MCP 2026-07-28 protocol model

Acceptance:

- the full v0.1 black-box suite remains green;
- tool contracts remain compatible unless a migration note explicitly documents a change;
- no server-side LLM dependency is introduced.

### 2. Native Streamable HTTP adapter

Keep stdio as a first-class local transport and add a native Streamable HTTP entry point.

Core requirements:

- stdio remains supported;
- HTTP transport contains no engineering business logic;
- Task durability remains transport-independent;
- clean process shutdown and restart semantics are tested;
- Host-header / deployment security guidance follows current MCP SDK recommendations.

Authentication remains a deployment boundary rather than a hidden Core dependency.

## P0 — Distribution and operations

### 3. Stable configuration schema

Replace ad-hoc environment-only configuration with a documented schema supporting:

- state directory;
- policy rules;
- persisted output limits;
- audit retention knobs;
- transport selection;
- HTTP bind address / port when HTTP is enabled.

Environment variables remain available for deployment overrides.

Configuration errors must fail closed with explicit diagnostics.

### 4. `agentdock doctor`

Add a deterministic diagnostics command that reports:

- Node version;
- Git version;
- writable state directory;
- Git worktree capability;
- MCP transport configuration;
- policy parse status;
- OS user;
- optional sudo capability without making sudo a hard requirement.

It must not print credentials.

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
