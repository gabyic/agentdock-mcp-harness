# 04 — Task survives disconnect and AgentDock restart
Status: IMPLEMENTED

Blocked by: 02, 03

## Goal
Deliver a truly durable coding Task.

## Acceptance criteria
- Persist Task, repo/base HEAD, worktree, key process metadata, and useful diagnostic state.
- After MCP disconnect/reconnect, task.resume restores the original Task/worktree/changes.
- Completed process state remains queryable.
- After full AgentDock process restart, the same task_id resumes successfully.
- A process running at AgentDock restart is not falsely restored as RUNNING; it is explicit INTERRUPTED or UNKNOWN.
- No Event Sourcing requirement is introduced.

## Demo
Create -> patch -> failing test -> restart AgentDock -> reconnect -> resume -> recover original worktree, changes, and failure metadata.
