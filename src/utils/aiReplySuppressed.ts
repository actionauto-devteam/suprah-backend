export class AiReplySuppressedError extends Error {
  constructor() { super('Alex reply suppressed by conversation state'); }
}
