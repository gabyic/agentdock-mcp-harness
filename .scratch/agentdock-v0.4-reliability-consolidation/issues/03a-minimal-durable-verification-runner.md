# 03A: Minimal Durable Verification Runner

**What to build:** Move already-decided deterministic verification steps out of the ChatGPT turn loop so they continue after the initiating MCP response returns. This is the minimal precursor to the full Durable Deterministic Plan Runner.

**Blocked by:** 03: Idempotent Mutating Operations

**Status:** done

- [x] `plan.start` creates an idempotent durable Plan and returns immediately while the first step is still running.
- [x] A Plan executes ordered shell/argv verification steps in the Task worktree using idempotent Run starts.
- [x] A successful Plan stops at `READY_TO_COMMIT`; it does not commit or finish the Task before Git retention/evidence tickets are complete.
- [x] A failed/interrupted step stops at `AWAITING_ASSISTANT` and later steps never execute.
- [x] `plan.get` exposes revision, current step, last successful step, blocker, and terminal state with bounded long-poll.
- [x] `plan.cancel` records durable cancellation and best-effort cancels only a locally owned active Run.
- [x] Exact `plan.start` retries reuse the same plan id; reusing the key with different steps fails closed.
- [x] Only the Plan owner runtime drives it; another runtime may observe/retry but cannot silently start a second driver.
- [x] Existing `task.resume` exposes `latest_plan` and returns `WAIT_FOR_PLAN` / `ASSISTANT_REQUIRED` when appropriate without requiring a new input schema.
- [x] Minimal Plans do not accept custom env until durable secret redaction is implemented.
- [x] No server-side LLM, hidden reasoning loop, automatic commit, or automatic task.finish is introduced.
- [x] Direct and MCP regression tests pass together with the existing full suite.
