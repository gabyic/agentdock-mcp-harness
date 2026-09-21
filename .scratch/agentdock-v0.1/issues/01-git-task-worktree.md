# 01 — Create a real Git Task with isolated worktree
Status: IMPLEMENTED

Blocked by: none

## Goal
Deliver the first full MCP -> AgentDock -> Linux -> Git vertical slice.

## Acceptance criteria
- Complete AgentDock MCP server starts and is callable by a black-box MCP client.
- repo.inspect identifies a real Git repository, HEAD, and dirty state.
- task.create returns unique task_id, base_head, and isolated worktree.
- Dirty source repo is allowed; Task is created from HEAD and uncommitted source changes are excluded.
- Source repo HEAD and working tree are unchanged by task creation.

## Demo
Create a Task against a dirty disposable Git repository and show a clean isolated worktree.
