# 02 — Reliable code read/search/edit inside Task worktree
Status: IMPLEMENTED

Blocked by: 01

## Goal
Deliver the coding file loop through public MCP primitives.

## Acceptance criteria
- file.read, file.search, file.patch, and file.write work through MCP.
- Relative paths resolve against the Task worktree.
- file.search supports deterministic text and glob/path filtering.
- Existing-file edits default to patch semantics.
- A stale patch returns explicit PATCH_CONFLICT and does not overwrite newer content.
- A new file can be created.
- git.diff returns structured real changes.
- All Task code changes remain in the Task worktree; source repo remains unchanged.

## Demo
Search for a symbol, patch it, create a new file, and obtain real Git diff through MCP.
