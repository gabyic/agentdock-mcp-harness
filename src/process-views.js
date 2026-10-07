// Lean views over a process service, for agents that pay for every byte they read (v0.5-01).
//
// Everything here is built only on the service's public start() and output(), so it behaves the same for the
// in-process ProcessService and for the SupervisorProcessClient that production uses (where processes live in
// the separate Run Supervisor and every call crosses a Unix socket): no supervisor protocol change, and no
// single IPC request is held open while waiting.
import { AgentDockError } from "./errors.js";

export const MAX_PROCESS_WAIT_MS = 60000;
export const MAX_TAIL_LINES = 2000;
const POLL_MS = 100;
const READ_PAGE = { maxBytes: 32 * 1024, maxChunks: 128 };
const ACTIVE_STATUSES = new Set(["RUNNING", "CANCELLING"]);      // the same rule as process-service.js

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTerminal(status) {
  return !ACTIVE_STATUSES.has(status);
}

export function compactRecord(record) {
  const { mode: _mode, argv: _argv, shell: _shell, cwd: _cwd, env: _env, ...rest } = record;
  return rest;
}

function checkWait(waitMs) {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_PROCESS_WAIT_MS) {
    throw new AgentDockError("INVALID_WAIT_TIMEOUT", `wait_ms must be an integer between 0 and ${MAX_PROCESS_WAIT_MS}.`);
  }
}

function checkTail(keep) {
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1 || keep > MAX_TAIL_LINES)) {
    throw new AgentDockError("INVALID_TAIL_LINES", `tail_lines must be an integer between 1 and ${MAX_TAIL_LINES}.`);
  }
}

/** Block until the process has output past `cursor` (until "output") or has ended (until "exit"), or waitMs. */
export async function waitForProcess(service, { taskId, processId, cursor = 0, waitMs = 0, until = "output" }) {
  checkWait(waitMs);
  if (until !== "output" && until !== "exit") {
    throw new AgentDockError("INVALID_WAIT_UNTIL", 'until must be "output" or "exit".');
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const page = await service.output({ taskId, processId, cursor, maxBytes: READ_PAGE.maxBytes, maxChunks: 1 });
    const done = isTerminal(page.status);
    if (done || (until === "output" && page.chunks.length > 0) || Date.now() >= deadline) {
      return { status: page.status, timed_out: !done && until === "exit" };
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

function tail(text, keep) {
  if (!text) return { text: "", dropped: 0 };
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length <= keep) return { text, dropped: 0 };
  const kept = lines.slice(lines.length - keep).join("\n");
  return { text: text.endsWith("\n") ? kept + "\n" : kept, dropped: lines.length - keep };
}

/**
 * Output as plain stdout/stderr strings (once, no chunk array). Without tailLines it is the same page output()
 * returns; with tailLines it reads everything available from the cursor and keeps the last lines of each stream.
 */
export async function textView(service, { taskId, processId, cursor = 0, maxBytes, maxChunks, tailLines }) {
  checkTail(tailLines);
  let page = await service.output({ taskId, processId, cursor, maxBytes, maxChunks });
  const chunks = [...page.chunks];
  if (tailLines !== undefined) {
    while (page.has_more) {
      page = await service.output({ taskId, processId, cursor: page.next_cursor, ...READ_PAGE });
      chunks.push(...page.chunks);
    }
  }
  const join = (stream) => chunks.filter((c) => c.stream === stream).map((c) => c.text).join("");
  let stdout = join("stdout");
  let stderr = join("stderr");
  const result = {
    process_id: processId,
    status: page.status,
    exit_code: page.exit_code,
    signal: page.signal,
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  };
  if (tailLines !== undefined) {
    const out = tail(stdout, tailLines);
    const err = tail(stderr, tailLines);
    stdout = out.text;
    stderr = err.text;
    if (out.dropped) result.stdout_lines_dropped = out.dropped;
    if (err.dropped) result.stderr_lines_dropped = err.dropped;
  }
  result.stdout = stdout;
  result.stderr = stderr;
  for (const flag of ["truncated_before_cursor", "live_output_truncated", "persisted_output_truncated"]) {
    if (page[flag]) result[flag] = true;
  }
  return result;
}

/**
 * Start a process and wait for it to end (or for waitMs); return its status and the tail of its output without
 * the command echo. A process that outlives waitMs keeps running (timed_out: true); continue from next_cursor.
 */
export async function execProcess(service, { taskId, argv, shell, cwd, env, idempotencyKey, waitMs = 30000, tailLines = 200 }) {
  checkWait(waitMs);
  checkTail(tailLines);
  const started = await service.start({ taskId, argv, shell, cwd, env, idempotencyKey });
  const waited = await waitForProcess(service, { taskId, processId: started.process_id, waitMs, until: "exit" });
  const text = await textView(service, { taskId, processId: started.process_id, tailLines });
  return { ...compactRecord(started), ...text, timed_out: waited.timed_out && !isTerminal(text.status) };
}
