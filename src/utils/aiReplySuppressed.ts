export class AiReplySuppressedError extends Error {
  constructor() { super('AI Agent reply suppressed by conversation state'); }
}
