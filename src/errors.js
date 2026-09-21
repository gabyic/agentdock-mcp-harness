export class AgentDockError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AgentDockError";
    this.code = code;
    this.details = details;
  }
}
