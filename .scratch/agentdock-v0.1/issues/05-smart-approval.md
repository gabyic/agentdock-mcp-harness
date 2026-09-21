# 05 — Task-scoped Smart Approval round-trip

Blocked by: 04

## Goal
Deliver approval semantics without introducing a second AI.

## Acceptance criteria
- Deterministic permission policy supports allow/ask/deny.
- ask produces a structured ApprovalRequest.
- Reviewer responses support ALLOW_ONCE, ALLOW_TASK, DENY, ASK_USER.
- ALLOW_TASK survives MCP reconnect/resume for the same Task.
- ALLOW_TASK does not apply to another Task.
- Durable approval state survives AgentDock restart where applicable.
- AgentDock performs zero LLM risk inference.
- A non-destructive test action demonstrates the complete approval chain.

## Demo
A safe operation asks once; reviewer grants ALLOW_TASK; equivalent action in same Task proceeds; a new Task asks again.
