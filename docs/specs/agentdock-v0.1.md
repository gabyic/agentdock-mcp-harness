# AgentDock v0.1 Specification

Status: FROZEN

## Purpose
AgentDock is a remote software-engineering execution harness exposed through MCP. v0.1 proves that ChatGPT Web can be the only reasoning agent and complete a professional coding loop on a real remote Linux machine without a second LLM or extra AI API key on the server.

## Topology
ChatGPT Web -> secure MCP connection layer -> AgentDock running directly on the target Linux server -> local Git/filesystem/process/OS.

No Gateway/Node split in v0.1. SSH is only bootstrap, maintenance, and break-glass diagnosis; it is not part of a formal acceptance coding task.

## Core principles
- ChatGPT Web is the only reasoning agent in Core Acceptance.
- AgentDock performs deterministic execution and zero LLM inference.
- Core responsibilities: Task lifecycle, Git/worktree isolation, files, processes, approval protocol, durable state, audit.
- Write-capable coding Tasks are Git-native.
- MCP surface = Task Lifecycle + Deterministic Engineering Primitives.
- Host permission semantics are inherited from the OS.
- Keep module seams clear, but do not add speculative cross-platform backend abstractions.

## Task model
Every write-capable task has a unique task_id. State-producing operations are task-scoped.

Minimum Task states:
- ACTIVE
- WAITING_APPROVAL
- COMPLETED
- FAILED
- CANCELLED

Only the main agent may finish a task explicitly with task.finish(). Passing tests or a successful commit never auto-finishes a Task.

task.cancel() stops further work, best-effort cancels running processes, marks CANCELLED, and preserves worktree/audit/changes.

task.cleanup() is separate and removes Task workspace resources.

## Durability
Task identity/state must survive MCP disconnect/reconnect and AgentDock process restart.

task.resume(task_id) restores at minimum:
- source repo
- base HEAD
- worktree
- existing changes
- task metadata
- process metadata
- approval metadata
- audit
- final commit metadata if present

Running OS processes are not checkpointed across AgentDock restart. A previously running process must not be falsely reported RUNNING after restart; it may become INTERRUPTED or UNKNOWN.

Use durable task state + operation audit. No Event Sourcing/CQRS requirement.

## Repository/worktree
task.create() inspects a real Git repository, records current HEAD as base_head, and creates an isolated Task worktree.

Dirty source repos are allowed. Uncommitted source changes/untracked files are excluded from the Task. Do not auto-stash, auto-commit, or import them.

Formal acceptance requires zero Task pollution of the source working tree.

First-class Git capabilities:
- repo.inspect
- worktree.create
- worktree.status
- git.diff
- git.commit

v0.1 supports real commit and returns commit SHA. Push/merge/deploy/PR/rebase orchestration are out of scope.

## Files
Worktree-first, not worktree-only.

Relative paths resolve against Task worktree. Explicit absolute host paths may be accessed according to native OS permissions.

Required primitives:
- file.read
- file.search
- file.patch
- file.write

file.search is deterministic text/path/glob search only.

file.patch is the default for modifying existing files and uses context validation. Stale context fails explicitly with PATCH_CONFLICT. AgentDock does not use AI to auto-resolve conflicts.

file.write is for new files or explicit whole-file replacement.

## Processes
Required primitives:
- process.start
- process.status
- process.output
- process.cancel

Every process has process_id and belongs to task_id.

No persistent shell, PTY, tmux abstraction, or terminal emulator in v0.1.

process.start has explicit cwd/env and supports mutually exclusive argv mode and shell mode.

process.output uses pull-based incremental cursor semantics.

Tests, lint, typecheck, and build are ordinary processes; there is no dedicated Test subsystem.

## Approval
Permission triggering is deterministic policy: allow / ask / deny.

AgentDock performs no AI risk classification. When policy returns ask, AgentDock emits a structured ApprovalRequest. Current ChatGPT acts as smart reviewer and returns:
- ALLOW_ONCE
- ALLOW_TASK
- DENY
- ASK_USER

ALLOW_TASK is Task-scoped, survives reconnect/resume, and ends with the Task. No persistent ALLOW_ALWAYS is required.

Host root/sudo behavior follows native host permissions. Successful sudo is not a Core Acceptance hard requirement.

## Rollback
Git/worktree changes are deterministically inspectable/recoverable.

AgentDock does not promise transactional rollback for arbitrary host side effects such as host file writes, package changes, DB mutations, service restarts, external API calls, or arbitrary shell effects. Such actions must be accurately reported/audited.

## Audit
Audit is structured operation history, not a full terminal recording.

It should allow reconstruction of:
- task
- timestamps
- source repo/base/worktree
- operations
- command mode/cwd
- exit codes
- changed files
- process references
- approval references
- final commit SHA

Persisted process diagnostic output is bounded.

Principle: Live fidelity, Audit redaction.
Live file/process results faithfully return OS-authorized content; persisted audit applies best-effort redaction for common credentials/tokens/passwords.

## Network/deployment
AgentDock Core exposes a standard MCP endpoint.

Core does not own public ingress, TLS certificate management, domains, reverse proxy, tunnel implementation, or firewall orchestration. v0.1 may use an existing secure MCP connection/tunnel layer.

## Concurrency
The data model must not assume only one Task can ever exist, but v0.1 acceptance does not require concurrent execution/scheduling.

## Explicit out of scope
- Gateway/Node architecture, registry, routing
- SSH execution transport abstraction
- macOS/Windows implementation
- Pi/OpenCode/Codex workers or server-side LLM inference
- persistent shell / PTY / tmux
- semantic/AST/LSP code search
- dedicated test framework subsystem
- Event Sourcing/CQRS
- push/merge/deploy/PR orchestration
- concurrent task scheduling guarantees
- universal host rollback
- browser/desktop/GUI/Xcode automation
- Kubernetes orchestration
- SaaS/team/RBAC/billing/dashboard/plugin marketplace
- automatic GC

## Primary automated test seam
Use one primary seam: MCP black-box integration.

Start the complete AgentDock MCP server and drive it through a real MCP client against a disposable real Git repo and real Linux filesystem/process/Git. Primary acceptance tests must not bypass MCP by directly calling internal Task/Git/Process services.

## Automated integration scenario
1. create disposable real Git repo
2. create task
3. verify isolated worktree
4. file read/search/patch
5. start real process and read incremental output
6. observe a real test failure
7. make a second modification
8. disconnect/reconnect and resume
9. restart AgentDock and resume again
10. trigger safe approval request and respond
11. targeted test pass
12. full suite pass
13. git.diff
14. real git.commit
15. task.finish
16. audit.get
17. verify source repository zero Task pollution

## Final product acceptance
Run from real ChatGPT Web through real AgentDock MCP on the current Leapscall Linux server using an independent real Git test repository.

Formal Task must:
- use no server-side LLM/API key
- use no autonomous worker
- use no SSH fallback after task.create
- create isolated worktree
- use file primitives
- observe real test FAIL
- use failure output to drive another edit
- experience a real MCP connection interruption
- resume same Task
- complete one real ChatGPT smart approval round-trip
- pass targeted/full tests
- produce real git diff
- create real commit and return commit SHA
- explicitly task.finish
- expose structured audit
- leave source repo zero-pollution

## Definition of Done
v0.1 is complete only when:
- MCP black-box integration suite passes
- AgentDock restart durability passes
- source-repo isolation passes
- process lifecycle passes
- approval round-trip passes
- real Git commit passes
- audit/redaction checks pass
- real ChatGPT Web E2E passes on Leapscall server
- no SSH fallback occurs during formal Task
- no second LLM/API key is required or used
