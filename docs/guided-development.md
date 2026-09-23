# Guided Development and Server-side Skills

AgentDock's guided-development layer lets a chat model use repository-hosted
engineering skills even when the chat product surface cannot invoke those skills
natively.

The design keeps the original AgentDock boundary:

- **ChatGPT / Claude Web is the reasoning agent.**
- **Skills are instruction resources, not executable agents.**
- **AgentDock is the deterministic execution harness.**
- **No second LLM, agent loop, or server-side prompt engine is introduced.**

## Why this exists

A user should be able to say:

> Continue this project.

without needing to remember whether the next engineering step is
`grill-with-docs`, `wayfinder`, `to-spec`, `to-tickets`, `implement`,
or `code-review`.

AgentDock therefore provides two small deterministic layers:

1. a Git-backed **Skill Resource Layer**;
2. a durable **Guided Workflow State** per repository.

The model still reads the skill and performs the reasoning.

## Skill tools

### `skill.install`

Installs a Git repository containing one or more `SKILL.md` files into the
AgentDock state directory.

Inputs:

- `source_id`: stable local name such as `mattpocock`;
- `repo_url`: `https://`, `file://`, or an absolute local Git repository;
- `ref`: optional branch/tag; when omitted, Git uses the repository's default branch;
- `replace`: explicit replacement of an existing source.

Installation clones instructions only. AgentDock does not execute repository
code as part of skill installation.

### `skill.update`

Re-clones an installed source from its recorded URL/ref and reports the old and
new Git commit. Existing source content is replaced only after the replacement
clone has been validated as containing at least one `SKILL.md`.

### `skill.list`

Lists discovered skills with:

- source;
- name;
- description;
- category;
- relative directory;
- exact installed source ref and Git commit;
- `disable-model-invocation` metadata.

### `skill.search`

Deterministic lexical search over skill name, description, and category. It
does not use embeddings or an LLM.

### `skill.read`

Reads either the skill's `SKILL.md` or a supporting file inside the same skill
directory. The result also contains the complete list of files available to
that skill.

Path traversal and symlink escapes outside the skill directory are rejected.

When a skill says to invoke or read another skill, the chat model should call
`skill.read` for that referenced skill and continue reasoning in the chat
context.

### `skill.invoke`

Provides a stable chat-facing invocation boundary for an installed skill. It
does **not** execute the skill on the server and does not start another model.
Instead it returns the exact installed instructions, source provenance, the
human/model invocation mode, and an execution contract stating that reasoning
stays in the chat model and deterministic actions stay in AgentDock.

`disable-model-invocation: true` is enforced at this boundary. Such a skill
(for example `ask-matt`) requires `invocation_mode=user`, and callers should
set that mode only when the human explicitly named or selected the skill.
Implicit/model invocation fails closed.

When `repo_path` is supplied through the MCP tool, AgentDock also returns the
current durable workflow context when one exists. Missing workflow state is
reported as `NOT_STARTED`; it is not silently created.

## Auto Matt routing

AgentDock can make the installed Matt workflow self-routing without adding a
second MCP service or a second reasoning model.

When `skills.matt_auto_routing=true`, the normal chat-side sequence is:

```text
user selects @AgentDock and describes software work
  -> skill.invoke(skill_name="auto", invocation_mode="model")
  -> AgentDock returns Ask Matt instructions + installed candidates
     + durable workflow context
  -> chat model chooses the matching Skill
  -> skill.invoke(chosen_skill, invocation_mode="model")
  -> AgentDock records authorization as auto_authorized when upstream marked
     that Skill user-invoked
  -> chat model follows the Skill and uses AgentDock execution tools
```

The router is advisory to the chat model, not an autonomous server loop.
`skill.invoke("auto")` never advances workflow state and never executes code.
Workflow transitions remain explicit and fail closed on unresolved decisions.

This mode is intended to remove the need for users to memorize `/wayfinder`,
`/grill-with-docs`, `/to-spec`, `/to-tickets`, `/implement`, `/code-review`,
and the rest of the Matt skill catalog. The human describes the work; the chat
model selects the method.

## Matt Pocock compatibility

A typical source installation is:

- source id: `mattpocock`
- repository: `https://github.com/mattpocock/skills.git`
- ref: `main`

The compatibility layer stores the upstream files unchanged. AgentDock does not
fork or rewrite Matt's workflow semantics.

The important engineering flow currently represented by those upstream skills
is:

```text
first use
  -> setup-matt-pocock-skills
  -> grill-with-docs
       -> optional prototype detour
       -> single-session: implement
       -> multi-session: to-spec -> to-tickets -> implement
  -> code-review
```

For a large multi-session effort whose route is still unclear, `wayfinder`
is an upstream planning on-ramp and hands back to `to-spec` when the map is
clear.

`implement` may itself instruct the model to read and follow `tdd` and
`code-review`. Those nested instructions remain model-side; AgentDock does not
turn them into a server-side agent runtime.

## Guided workflow tools

### `workflow.start`

Starts durable workflow state for a repository. Existing workflow state is
protected by default; starting a new goal on the same repository requires
`replace=true` so an accidental call cannot erase the current phase.

The caller supplies the software goal plus its current routing assessment:

- `session_span`: `single`, `multi`, or `unknown`;
- `route_clarity`: `clear`, `foggy`, or `unknown`;
- `decisions_settled`: whether planning decisions are already settled;
- `replace`: explicit acknowledgement when replacing existing workflow state.

Before the first engineering flow, AgentDock checks the actual upstream setup
contract:

- `docs/agents/issue-tracker.md`;
- `docs/agents/domain.md`;
- `CLAUDE.md` when it exists, otherwise `AGENTS.md`, with an
  `## Agent skills` block;
- `docs/agents/triage-labels.md` when the installed skill set contains
  `triage`.

If any required item is absent, the first phase is `SETUP`, the recommendation
is `setup-matt-pocock-skills`, and `workflow.guide` reports the exact missing
items.

Otherwise routing is deterministic:

- multi-session + foggy + unsettled -> `WAYFINDING`;
- unsettled -> `GRILLING`;
- settled + multi-session -> `SPEC`;
- settled + single-session -> `IMPLEMENT`.

### `workflow.list`

Lists durable project workflows, excluding completed work by default. This is
the recovery surface for a fresh chat: the model can discover active projects,
their goals, current phase, open decisions, and recommended next skill instead
of asking the user to reconstruct prior development state.

### `workflow.update`

Persists progress **inside** the current phase without moving the state machine.
It can record:

- current session-size classification;
- route clarity;
- unresolved decision questions;
- named artifact paths such as `CONTEXT.md`, a spec, or ticket set;
- a short progress note.

This is what makes a long Grill/Wayfinder session durable across chat windows.
Recording any open decision marks the workflow as unsettled.

### `workflow.status`

Read-only alias for the current durable workflow state plus the same
recommendation produced by `workflow.guide`. It exists as the stable App-facing
status primitive; it never advances a phase or executes a skill.

### `workflow.guide`

Returns current durable state plus:

- phase;
- recommended skill;
- whether that skill is installed;
- why the phase is next;
- the human decision boundary;
- a handoff instruction that tells the chat model where an upstream skill must
  return control to the durable workflow.

For example, upstream `implement` ends by saying to use `/code-review`.
Guided Development intercepts that handoff: the model records
`implementation_complete`, the workflow enters `REVIEW`, and
`code-review` is recommended exactly once.

This is the primary tool to call when the user says things such as:

- "continue";
- "what do I do next?";
- "I don't know what the next development step is."

It never executes the recommended skill.

### `workflow.advance`

Moves the state machine only at an explicit phase boundary.

Supported events:

- `setup_complete`
- `grilling_complete`
- `prototype_needed`
- `prototype_complete`
- `map_clear`
- `spec_complete`
- `tickets_complete`
- `implementation_complete`
- `review_passed`
- `review_changes_requested`
- `blocked`
- `resume`

Invalid phase jumps fail closed.

`setup_complete` is accepted only after the required setup documents actually
exist.

`grilling_complete` is accepted only after the caller has classified the work
as single-session or multi-session; AgentDock will not silently guess.

`grilling_complete`, `map_clear`, and `spec_complete` also fail closed while
`open_decisions` is non-empty. The model must resolve or explicitly clear those
decisions through `workflow.update` before crossing the boundary.

## State

Both layers live under the configured AgentDock state directory:

```text
<state-dir>/
  skills/
    sources/
    metadata/
  workflows/
```

Skill sources and workflow state therefore survive MCP reconnects and AgentDock
process restarts without modifying the user's source checkout.

The Matt skills themselves may intentionally write project artifacts such as
`CONTEXT.md`, ADRs, specs, or local issue files when their instructions call
for it. Those writes should still go through the normal AgentDock Task/file/git
boundary.

## Trust model

A Git skill repository is **instructions supplied by the user**, not trusted
code.

AgentDock:

- records the installed Git commit;
- never evaluates a `SKILL.md`;
- never imports code from a skill repository;
- does not run install hooks;
- exposes skill content to the chat model only when requested.

The model should still treat newly installed third-party instructions as
untrusted input and keep normal AgentDock approval, audit, Task isolation, and
OS-permission boundaries intact.

### Host capability adaptation

Some upstream skills assume features the current chat host may not expose. The
important example is `code-review`, which asks for two parallel sub-agents.
AgentDock deliberately does not create a second LLM runtime to emulate that.
When the host has no sub-agent primitive, `workflow.guide` requires two
explicit review passes (Standards and Spec), keeps their findings separate, and
requires the assistant to disclose that context isolation was unavailable.
This preserves the decision/workflow semantics without pretending the host has
a capability it does not have.

## Non-goals

Guided Development deliberately does not add:

- `skill.execute`;
- a server-side LLM;
- an autonomous agent loop;
- prompt chaining inside AgentDock;
- automatic acceptance of product decisions;
- hidden progression across human phase boundaries.

The product rule remains:

> Skill = instructions. Chat model = brain. AgentDock = hands + durable state.
> `@AgentDock` is the single App boundary; Matt-style skills remain an internal
> resource/workflow layer, not a second MCP service.
