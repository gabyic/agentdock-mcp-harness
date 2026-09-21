# AgentDock MCP Harness

> A deterministic remote software-engineering harness for ChatGPT and other MCP clients.

AgentDock MCP Harness lets an MCP-capable reasoning agent work on a real Linux machine without requiring a second LLM on the server. The model reasons; AgentDock executes deterministic engineering primitives for Git, files, processes, approvals, durable task state, and audit.

**Status:** v0.1 Core is complete and has passed both automated MCP black-box acceptance and a live ChatGPT Web acceptance on a real Linux server.

> Naming note: this project is not affiliated with other projects named AgentDock. The public repository uses **AgentDock MCP Harness** to distinguish this execution harness from unrelated agent frameworks and desktop tools.

## Why

Most "coding agent" servers bundle another model, another API key, another orchestration layer, or an opaque terminal session. AgentDock takes a narrower approach:

- the MCP client is the reasoning agent;
- the server performs deterministic execution only;
- every write-capable coding task is isolated in a Git worktree;
- task state survives MCP disconnects and AgentDock restarts;
- approvals are deterministic policy gates, with the connected agent acting as reviewer;
- host access follows native OS permissions;
- audit records what happened without pretending arbitrary host side effects are transactionally reversible.

## Architecture

```text
ChatGPT / MCP client
        |
        | MCP
        v
+-------------------------+
| AgentDock MCP Harness   |
|-------------------------|
| Task lifecycle          |
| Git / worktrees         |
| File primitives         |
| Process lifecycle       |
| Deterministic policy    |
| Smart approval protocol |
| Durable state           |
| Structured audit        |
+-------------------------+
        |
        v
 Linux filesystem / Git / processes / OS
```

For remote deployments, TLS, public ingress, and OAuth can remain outside Core:

```text
ChatGPT Web
   |
 HTTPS + OAuth
   |
auth / reverse proxy
   |
stdio or HTTP adapter
   |
AgentDock Core
```

## v0.1 capabilities

### Task lifecycle

- `task.create`
- `task.resume`
- `task.finish`
- `task.cancel`
- `task.cleanup`

Write-capable tasks are Git-native and get an isolated worktree based on the source repository's current `HEAD`. Dirty source repositories are allowed; their uncommitted changes are not copied into the Task.

### Files

- `file.read`
- `file.search`
- `file.patch`
- `file.write`

Relative paths resolve against the Task worktree. Explicit absolute paths access the host according to native OS permissions.

`file.patch` uses optimistic concurrency through a SHA-256 returned by `file.read`; stale edits fail with `PATCH_CONFLICT`.

### Processes

- `process.start`
- `process.status`
- `process.output`
- `process.cancel`

Processes are asynchronous, Task-scoped, and support explicit argv or shell mode. Output is pulled incrementally with cursor semantics.

Persisted diagnostic output is bounded; live output preserves fidelity.

### Git

- `repo.inspect`
- `git.diff`
- `git.commit`

v0.1 creates real local commits but does not implement push, merge, deploy, PR, or rebase orchestration as first-class AgentDock tools.

### Approval

Deterministic policy produces one of:

- `allow`
- `ask`
- `deny`

When policy returns `ask`, AgentDock emits a structured ApprovalRequest. The connected reasoning agent can answer:

- `ALLOW_ONCE`
- `ALLOW_TASK`
- `DENY`
- `ASK_USER`

AgentDock performs no LLM risk classification.

### Audit

`audit.get` exposes structured Task history including:

- Task lifecycle;
- workspace versus host file access;
- process IDs, cwd, status, exit code and timestamps;
- approvals;
- Git commit SHA;
- completion state.

Persisted audit uses best-effort secret redaction. Live file/process responses remain faithful to the OS-authorized content.

## Proven acceptance path

The v0.1 acceptance suite exercises the public MCP surface against a disposable real Git repository:

```text
task.create
  -> isolated worktree
  -> file.search / file.read / first patch
  -> real targeted test FAIL
  -> inspect failure
  -> second failure-driven patch
  -> disconnect / reconnect
  -> AgentDock restart / task.resume
  -> Smart Approval
  -> targeted test PASS
  -> full suite PASS
  -> git.diff
  -> real git.commit
  -> task.finish
  -> audit.get
  -> source repository zero-pollution
```

Run it with:

```bash
npm run acceptance:v0.1
```

## Requirements

v0.1 currently targets:

- Linux
- Node.js 24+
- Git
- an MCP client capable of invoking the exposed tools

macOS and Windows are not implemented in v0.1.

## Install from source

Clone and install:

```bash
git clone https://github.com/gabyic/agentdock-mcp-harness.git
cd agentdock-mcp-harness
./scripts/install.sh
```

The installer performs a user-local installation by default and does not require root for Core.

See [docs/deployment.md](docs/deployment.md) for local MCP configuration and remote deployment guidance.

## Development

```bash
npm ci
npm test
npm run acceptance:v0.1
```

The primary test seam is MCP black-box integration. Tests intentionally use real Git repositories, real worktrees, real filesystem operations and real child processes rather than bypassing MCP to call service classes directly.

## Security model

AgentDock is an execution harness. An authenticated client can intentionally run commands and access host paths permitted to the AgentDock OS user.

Important properties:

- no hidden sandbox is implied;
- host permissions come from the operating system;
- approval policy is deterministic;
- Task write operations are isolated in Git worktrees;
- arbitrary host side effects are audited but are not promised universal rollback;
- persisted audit redacts common secret patterns on a best-effort basis.

Do not expose AgentDock directly to the public internet without an authentication layer.

See [SECURITY.md](SECURITY.md).

## Roadmap

v0.2 focuses on production distribution and protocol modernization rather than feature sprawl:

- MCP 2026-07-28 / TypeScript SDK v2 migration;
- native Streamable HTTP adapter while retaining stdio;
- stable configuration schema and `doctor` diagnostics;
- installation / upgrade / uninstall lifecycle;
- service health and restart hardening;
- release CI, versioning and reproducible packages;
- documentation for remote ChatGPT deployment.

See [docs/roadmap-v0.2.md](docs/roadmap-v0.2.md).

## Non-goals for v0.2

These remain deliberately deferred:

- server-side LLM inference;
- autonomous Pi/OpenCode/Codex workers;
- macOS / Windows execution backends;
- browser / GUI automation;
- Kubernetes orchestration;
- SaaS, billing, teams or RBAC;
- universal rollback for arbitrary host side effects.

## License

MIT. See [LICENSE](LICENSE).
