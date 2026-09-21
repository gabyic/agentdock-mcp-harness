# 07 — Host access and structured Audit

Blocked by: 02, 03, 05, 06

## Goal
Support real server development beyond the repo while preserving clear workspace/host semantics and useful audit.

## Acceptance criteria
- Relative file paths default to Task worktree.
- Explicit absolute host paths are accessible according to native OS permissions.
- Acceptance uses a safe temporary host path, not production configuration.
- Audit distinguishes WORKSPACE_READ/WRITE and HOST_READ/WRITE.
- Audit links Task, process, approval, Git commit, exit code, timestamps, and cwd.
- Persisted process output is bounded.
- Persisted Audit performs best-effort secret redaction.
- Live file/process results preserve fidelity.
- Host side effects are auditable but not presented as universally rollbackable.

## Demo
Modify a worktree file and a safe /tmp host file; show Audit separating both. Demonstrate live secret fidelity but redacted persisted audit.
