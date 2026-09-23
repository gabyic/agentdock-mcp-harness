# AgentDock v0.3 Roadmap

v0.3 adds guided development without turning AgentDock into a second AI agent.

## P0 — Guided Development

- [x] Git-backed server-side Skill Resource Layer.
- [x] `skill.install` and atomic source replacement.
- [x] `skill.update` with source commit evidence.
- [x] `skill.list`, `skill.search`, and supporting-resource `skill.read`.
- [x] Explicit `skill.invoke` gateway with user-vs-model invocation enforcement and no server-side LLM.
- [x] Matt Pocock skills repository compatibility.
- [x] Durable per-repository workflow state.
- [x] Cross-chat active workflow discovery with `workflow.list`.
- [x] Read-only `workflow.status` alias for stable chat/App integration.
- [x] In-phase durable progress with `workflow.update`.
- [x] First-use `setup-matt-pocock-skills` precondition.
- [x] Single-session vs multi-session routing.
- [x] `wayfinder` routing only for multi-session foggy work.
- [x] Prototype detour and return to planning.
- [x] Open-decision guardrails at planning boundaries.
- [x] Deterministic phase-boundary transitions.
- [x] Missing-skill detection instead of silent fallback.
- [x] Legacy and MCP 2026-07-28 tool-surface parity.
- [x] No server-side LLM or Skill execution runtime.

## P1 — Operational polish

- [ ] CLI wrappers for skill install/list/update.
- [ ] Source allowlist / organization policy for multi-user deployments.
- [ ] Optional source pinning policy for production installations.
- [ ] Workflow summaries in `agentdock doctor`.
- [ ] Human-friendly workflow history rendering.
- [ ] Optional local issue-tracker helpers that remain deterministic.

## Deferred

These do not belong in Guided Development Core:

- autonomous Codex/OpenCode/Claude workers;
- a server-side model router;
- automatic product decisions;
- executing arbitrary code from skill repositories;
- a plugin marketplace.

See [guided-development.md](guided-development.md).
