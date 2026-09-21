import { redactObject } from "./redaction.js";

export class AuditService {
  #store;

  constructor({ stateStore }) {
    this.#store = stateStore;
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
    this.#store.saveAudit(taskId, audit);
    return item;
  }

  get(taskId, { afterSequence = 0, limit = 500 } = {}) {
    const audit = this.#store.loadAudit(taskId);
    const entries = audit.entries
      .filter((entry) => entry.sequence > afterSequence)
      .slice(0, limit);

    return {
      task_id: taskId,
      after_sequence: afterSequence,
      entries,
      next_sequence: entries.length
        ? entries[entries.length - 1].sequence + 1
        : afterSequence + 1,
      has_more:
        audit.entries.filter((entry) => entry.sequence > afterSequence).length >
        entries.length,
    };
  }
}
