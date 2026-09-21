import { redactObject } from "./redaction.js";
import { DEFAULT_AUDIT_MAX_ENTRIES_PER_TASK } from "./config.js";

export class AuditService {
  #store;
  #maxEntriesPerTask;

  constructor({
    stateStore,
    maxEntriesPerTask = DEFAULT_AUDIT_MAX_ENTRIES_PER_TASK,
  }) {
    if (!Number.isInteger(maxEntriesPerTask) || maxEntriesPerTask < 1) {
      throw new TypeError("maxEntriesPerTask must be a positive integer.");
    }
    this.#store = stateStore;
    this.#maxEntriesPerTask = maxEntriesPerTask;
  }

  append(taskId, entry) {
    const audit = this.#store.loadAudit(taskId);
    const now = new Date().toISOString();
    const item = redactObject({
      sequence: audit.next_sequence,
      task_id: taskId,
      timestamp: now,
      ...entry,
    });

    audit.entries.push(item);
    audit.next_sequence += 1;
    if (audit.entries.length > this.#maxEntriesPerTask) {
      audit.entries.splice(
        0,
        audit.entries.length - this.#maxEntriesPerTask,
      );
    }
    this.#store.saveAudit(taskId, audit);
    return item;
  }

  get(taskId, { afterSequence = 0, limit = 500 } = {}) {
    const audit = this.#store.loadAudit(taskId);
    const entries = audit.entries
      .filter((entry) => entry.sequence > afterSequence)
      .slice(0, limit);

    const oldestRetainedSequence =
      audit.entries.length > 0
        ? audit.entries[0].sequence
        : audit.next_sequence;

    return {
      task_id: taskId,
      after_sequence: afterSequence,
      entries,
      next_sequence: entries.length
        ? entries[entries.length - 1].sequence + 1
        : audit.next_sequence,
      has_more:
        audit.entries.filter((entry) => entry.sequence > afterSequence).length >
        entries.length,
      retained_from_sequence: oldestRetainedSequence,
      truncated_before_sequence:
        oldestRetainedSequence > 1 &&
        afterSequence < oldestRetainedSequence - 1,
    };
  }
}
