# AgentDock MCP Harness

> **无限流 / Infinite Coding Flow**
>
> **把 ChatGPT / Claude 网页版的大额度、近似无限配额，变成你的远程 Coding Token 池。**
>
> **Use your ChatGPT / Claude Web quota as a remote coding agent — no second API token meter.**

如果你的 ChatGPT / Claude 网页套餐本身提供大额度或近似无限的使用量，AgentDock 就能让这部分现有配额直接驱动你自己 Linux 服务器上的真实开发流程，而不是再额外购买一套 Coding Agent API Token。

If your chat plan gives you high or near-unlimited usage, AgentDock lets that same chat-model quota drive real remote software engineering on your own Linux server.

**No second coding model. No extra server-side AI API key. No separate per-token reasoning bill.**

AgentDock keeps ChatGPT / Claude / another MCP-capable chat client as the **only reasoning agent** and adds the missing execution layer: Git worktrees, file editing, shell/process execution, tests, durable tasks, approvals, commits, host access, and audit.

### Why the token model matters

Long coding tasks are token-hungry. A real debugging loop may repeatedly:

```text
read code
→ search more files
→ reason
→ edit
→ run tests
→ inspect failure
→ reason again
→ edit again
→ run the full suite
→ review diff
```

With an API-based coding agent, every reasoning loop consumes separately billed API tokens.

With AgentDock, the reasoning stays inside the chat product you already use. If your ChatGPT / Claude plan provides a large or near-unlimited chat allowance, **that existing allowance becomes the reasoning budget for remote coding**, while the server only executes deterministic MCP tools.

> AgentDock does not claim that every chat subscription is literally unlimited. Plans can have usage, rate, or context limits. The value proposition is that AgentDock adds **no second model/API token meter on the server**.

**Status:** v0.1 Core is complete and has passed both automated MCP black-box acceptance and a live ChatGPT Web acceptance on a real Linux server.

> Naming note: this project is not affiliated with other projects named AgentDock. The public repository uses **AgentDock MCP Harness** to distinguish this execution harness from unrelated agent frameworks and desktop tools.

**Get started:** [Quick deployment](#quick-deployment) · [Full deployment guide](docs/deployment.md) · [Configuration](docs/configuration.md) · [Service lifecycle](docs/service-lifecycle.md)

## What problem does it solve?

### 1. ChatGPT Web is smart, but it cannot normally work on your server

Chat models can reason about code extremely well, but without an execution harness they cannot reliably:

- inspect a real repository;
- edit files safely;
- run tests and builds;
- manage long-running processes;
- create isolated Git changes;
- survive a dropped MCP connection;
- commit the finished result.

AgentDock turns MCP from a collection of remote commands into a durable software-engineering workflow.

### 2. You should not need a second AI just to execute code

Many "coding agent" architectures look like this:

```text
ChatGPT
   |
   v
remote server
   |
   v
another LLM / coding agent API
   |
   v
shell / files / Git
```

That creates duplicated reasoning, duplicated context, another API key, and another token bill.

AgentDock uses:

```text
ChatGPT / Claude / MCP client
          |
          | reasoning + decisions
          v
       AgentDock
          |
          | deterministic execution
          v
 Git / files / processes / Linux
```

**One reasoning agent. No server-side LLM required.**

### 3. A raw SSH MCP is not a professional coding harness

Giving a model `ssh` or `run_command` is useful, but it leaves the model responsible for inventing its own engineering workflow every time.

AgentDock provides first-class primitives for:

- Task lifecycle;
- isolated Git worktrees;
- file read/search/patch/write;
- asynchronous processes;
- incremental output;
- test failure inspection;
- Git diff and commit;
- approval requests;
- structured audit.

The model reasons about the software problem instead of repeatedly rebuilding shell orchestration.

### 4. Long coding tasks should survive disconnects

Browser sessions, MCP connections, OAuth proxies, and remote services can restart.

AgentDock persists Workspace Task and Run/process metadata so the same `task_id` can resume after a reconnect or AgentDock restart. Each running process records an execution-owner lease: another live AgentDock runtime may observe it as remotely owned without rewriting its state, while a process whose owner actually disappears is reconciled to `INTERRUPTED`.

### 5. AI coding should not pollute your source checkout

Every write-capable coding Task gets its own Git worktree based on the source repository's current `HEAD`.

Your source checkout can even be dirty; AgentDock keeps those existing uncommitted changes out of the Task.

The AI can test, edit, diff, and commit in isolation while the source working tree remains untouched.

### 6. Powerful remote access needs approval and evidence

AgentDock can intentionally access host files and run commands using the permissions of its OS user.

Instead of pretending this is risk-free, AgentDock makes the boundary explicit:

- deterministic `allow / ask / deny` policy;
- structured ApprovalRequest;
- `ALLOW_ONCE / ALLOW_TASK / DENY / ASK_USER`;
- workspace-vs-host audit;
- process exit codes and timestamps;
- Git commit evidence;
- best-effort secret redaction in persisted audit.

## What do you get?

With AgentDock connected, a chat model can carry out a workflow like:

```text
"Fix this bug on my server"
        |
        v
inspect repo
        |
create isolated Task/worktree
        |
search + read code
        |
edit
        |
run real test -> FAIL
        |
read failure
        |
edit again
        |
test -> PASS
        |
full suite -> PASS
        |
review git diff
        |
create real commit
        |
finish Task
        |
return commit SHA + audit
```

All of that can happen while **the chat model remains the brain and AgentDock remains the execution harness**.

## Who is this for?

AgentDock is especially useful if you:

- already use ChatGPT Web / Claude / another strong MCP-capable chat model;
- want that chat model to work directly on a remote Linux development machine;
- do not want to run or pay for a second server-side coding model;
- want more structure than a generic SSH MCP;
- care about Git isolation, resumability, approvals, and auditability;
- want a coding-harness experience from the browser rather than another local coding-agent application.

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

### Workspace Task lifecycle

- `task.create`
- `task.evidence.record`
- `task.list`
- `task.resume`
- `task.finish`
- `task.cancel`
- `task.cleanup`

Write-capable Workspace Tasks are Git-native and get an isolated worktree based on the source repository's current `HEAD`. Dirty source repositories are allowed; their uncommitted changes are not copied into the Task. A caller may give `task.create` a Completion Contract and use `task.evidence.record` to persist required PASS/FAIL checks against the current commit. `task.resume` returns a bounded recent-process summary plus active processes and a `recommended_next_action` instead of replaying the entire process history. `task.list` is read-only and exposes stale-by-last-activity status, blockers, worktree presence/size, active Runs, and aggregate state-directory/worktree usage without deleting anything.

### Files

- `file.read`
- `file.search`
- `file.patch`
- `file.write`

Relative paths resolve against the Task worktree. Explicit absolute paths access the host according to native OS permissions.

`file.patch` uses optimistic concurrency through a SHA-256 returned by `file.read`; stale edits fail with `PATCH_CONFLICT`.

### Runs and process compatibility

Preferred long-running execution surface:

- `run.start`
- `run.get`
- `run.cancel`

A Run is one asynchronous execution inside a Workspace Task. `run.start` returns a durable `run_id` immediately; `run.get` provides bounded cursor-based output with an optional long-poll of at most 10 seconds; `run.cancel` cancels a locally owned Run. This interface is intentionally shaped so it can map onto MCP Tasks as client support matures.

The lower-level compatibility/debug surface remains available:

- `process.start`
- `process.status`
- `process.output`
- `process.cancel`

Process output is paged. New live output is retained in a bounded in-memory window, persisted diagnostic output keeps a bounded tail, and no normal output call is allowed to replay an unbounded command transcript. Live output remains faithful for debugging; persisted command/env/stdout/stderr diagnostic state is best-effort redacted before durable storage.

### Durable verification Plans

Already-decided deterministic verification chains can continue after the initiating ChatGPT/MCP response returns:

- `plan.start`
- `plan.get`
- `plan.cancel`
- `plan.continue`

The durable Plan Runner executes only caller-declared deterministic steps. Steps have stable ids and idempotency keys, may form an acyclic dependency graph, declare exit-code success criteria and Completion Contract evidence, and retry only when explicitly marked safe. It supports explicit reasoning and human barriers, policy approval waits, safe Git commit and Task finish actions, and Supervisor-backed recovery after a transport process restarts. `plan.continue` releases only an explicit barrier or an already-resolved approval; failed or ambiguous work remains `AWAITING_ASSISTANT` and cannot be auto-repaired. No server-side LLM or hidden reasoning loop is used.

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

AgentDock currently targets:

- Linux
- Node.js 24+
- Git
- an MCP client capable of invoking the exposed tools

AgentDock supports stdio and native stateless Streamable HTTP. Remote deployments should keep AgentDock on loopback/private networking and add an authenticated connection layer in front.

macOS and Windows execution backends are not implemented yet.

## Quick deployment

For a Linux server that will be used from ChatGPT or another remote MCP client:

```bash
git clone https://github.com/gabyic/agentdock-mcp-harness.git
cd agentdock-mcp-harness
./scripts/install.sh

mkdir -p ~/.config/systemd/user
cp ~/.local/share/agentdock-mcp-harness/deploy/systemd/agentdock-http.service \
  ~/.config/systemd/user/agentdock-http.service

systemctl --user daemon-reload
systemctl --user enable --now agentdock-http.service

agentdock doctor
agentdock health
```

The default remote MCP endpoint stays private on:

```text
http://127.0.0.1:3100/mcp
```

For ChatGPT, the recommended deployment is **AgentDock on loopback + OpenAI Secure MCP Tunnel** when your OpenAI account/workspace supports it. An authenticated HTTPS/OAuth MCP gateway is the alternative for self-managed public ingress.

**Do not expose AgentDock's unauthenticated HTTP endpoint directly to the public internet.**

The complete step-by-step guide, including ChatGPT Developer Mode, Secure MCP Tunnel, tool refresh after upgrades, production verification, and troubleshooting, is in **[docs/deployment.md](docs/deployment.md)**.

## Install from source

Clone and install:

```bash
git clone https://github.com/gabyic/agentdock-mcp-harness.git
cd agentdock-mcp-harness
./scripts/install.sh
```

The installer performs a user-local installation by default and does not require root for Core.

AgentDock uses a versioned JSON configuration schema at `~/.config/agentdock/config.json`. Existing `AGENTDOCK_*` environment variables remain supported as higher-precedence deployment overrides.

After installation, verify the environment with:

```bash
agentdock doctor
```

For CI or automation:

```bash
agentdock doctor --json
```

Doctor checks Node, Git/worktrees, the effective configuration, state-directory writability, transport, policy, OS user and optional passwordless sudo without printing credential values.

For native HTTP service health and readiness:

```bash
agentdock health
agentdock health --wait-ms 10000
```

Managed installs support explicit lifecycle commands:

```bash
agentdock upgrade --source /path/to/new-agentdock
agentdock uninstall
```

Ordinary uninstall preserves durable state and config. Destructive cleanup requires explicit `--remove-state` / `--remove-config`.

Build a reproducible release archive from a clean Git checkout with:

```bash
npm run release:build
```

See [docs/configuration.md](docs/configuration.md), [docs/doctor.md](docs/doctor.md), [docs/lifecycle.md](docs/lifecycle.md), [docs/service-lifecycle.md](docs/service-lifecycle.md), [docs/releasing.md](docs/releasing.md), and [docs/deployment.md](docs/deployment.md).

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

- ✅ MCP 2026-07-28 / TypeScript SDK v2 migration;
- ✅ native stateless Streamable HTTP while retaining stdio;
- ✅ stable versioned configuration schema with env overrides;
- ✅ `agentdock doctor` diagnostics;
- ✅ managed install / upgrade / uninstall lifecycle;
- ✅ service health and restart hardening;
- ✅ release CI, versioning, reproducible packages and v0.2.0 RC gate;
- documentation for remote ChatGPT deployment.

See [docs/roadmap-v0.2.md](docs/roadmap-v0.2.md).

The v0.3 development line adds **Guided Development** for users who want the
chat model to keep track of the software-engineering process as well as execute
it:

- Git-backed server-side skill resources that remain plain instructions;
- deterministic `skill.list/search/read/install/update` MCP tools plus a
  `skill.invoke` gateway that supports explicit invocation and Auto Matt routing
  without adding another MCP tool;
- durable per-repository workflow state with `workflow.list`, `workflow.status`,
  `workflow.update`, and a `workflow.guide` "what next?" surface;
- compatibility with Matt Pocock's engineering skills flow, including first-use
  setup, grilling, wayfinding, specs, tickets, implementation and review;
- one `@AgentDock` App/MCP boundary: Skills and Guided Workflow are internal
  AgentDock layers rather than a second Matt MCP;
- optional Auto Matt mode: describe the engineering task and let the chat model
  choose `wayfinder`, `grill-with-docs`, `implement`, `diagnosing-bugs`,
  `code-review`, or another installed Skill from the upstream routing rules;
- no server-side LLM and no `skill.execute` agent runtime.

See [docs/guided-development.md](docs/guided-development.md) and
[docs/roadmap-v0.3.md](docs/roadmap-v0.3.md).

The v0.4 line focuses on ChatGPT public distribution and directory readiness: tool safety metadata, reviewer evals, submission materials, and the unresolved Universal-vs-self-hosted distribution topology.

See [docs/roadmap-v0.4.md](docs/roadmap-v0.4.md) and [docs/plugin/submission-readiness.md](docs/plugin/submission-readiness.md).

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
