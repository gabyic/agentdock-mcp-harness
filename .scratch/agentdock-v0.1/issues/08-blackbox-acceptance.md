# 08 — Automated MCP black-box v0.1 Acceptance

Blocked by: 04, 05, 06, 07

## Goal
Freeze the v0.1 Spec into a repeatable black-box regression scenario through the public MCP surface.

## Acceptance criteria
A single automated scenario performs:
1. disposable real Git repo
2. stable intentional bug
3. task.create
4. isolated worktree
5. read/search/patch
6. real targeted test FAIL
7. read real failure
8. second modification
9. simulate MCP disconnect/reconnect and resume
10. restart AgentDock and resume
11. approval request/response
12. targeted test PASS
13. full suite PASS
14. git.diff
15. real git.commit
16. task.finish
17. audit.get
18. source repo zero-pollution verification

The scenario asserts no server-side LLM dependency and no SSH fallback in the formal Task path.

## Demo
One automated acceptance entry point proves AgentDock Core end-to-end.
