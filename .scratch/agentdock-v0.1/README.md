# AgentDock v0.1 local issue tracker

Source spec: docs/specs/agentdock-v0.1.md

One /implement run per issue. Use a fresh context per issue. One commit per issue.

Dependency graph:

01
├── 02 ──┐
└── 03 ──┴──> 04 ──> 05 ──┐
              └────> 06 ───┤
02/03/05/06 ─────────> 07 ─┤
04/05/06/07 ─────────> 08 ──> 09
