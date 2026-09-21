# 06 — Commit, finish, cancel, and cleanup Task lifecycle
Status: IMPLEMENTED

Blocked by: 02, 03, 04

## Goal
Complete the Git Task lifecycle with explicit completion and cleanup semantics.

## Acceptance criteria
- git.commit creates a real commit in the Task worktree and returns commit SHA.
- No push/merge/deploy occurs.
- task.finish explicitly marks COMPLETED and keeps worktree.
- task.cancel best-effort stops running processes, marks CANCELLED, and preserves the scene.
- task.cleanup is the operation that removes Task workspace resources.
- Source repo remains zero-pollution.
- Git/worktree changes are recoverable; arbitrary host side effects are not falsely promised transactional rollback.

## Demo
Pass tests -> commit -> finish -> inspect retained worktree. Separately cancel another Task, inspect retained state, then cleanup.
