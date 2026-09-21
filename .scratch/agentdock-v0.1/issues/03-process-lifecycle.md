# 03 — Real asynchronous development Process lifecycle
Status: IMPLEMENTED

Blocked by: 01

## Goal
Move beyond synchronous command execution to a real Harness process model.

## Acceptance criteria
- process.start/status/output/cancel are available via MCP.
- Every process has process_id and belongs to task_id.
- argv mode works.
- shell mode works.
- cwd/env are explicit and auditable.
- process.output uses incremental cursor semantics.
- A process may continue after the MCP call that started it returns.
- cancel best-effort stops a real running process.
- A real failing test exposes exit code and diagnostic output.

## Demo
Start a long-output command, read output incrementally, cancel it, then run a real failing test.
