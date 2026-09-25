/**
 * Produce a log-safe copy of request data. Error logs used to record the full
 * request body, which included GPS coordinates, 200 KB signature images,
 * Dispatch Chat message text and credentials. Keys and structure are kept so
 * failures stay debuggable; sensitive values are replaced.
 */

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 200;

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /pass(word)?/i,
  /token/i,
  /secret/i,
  /authorization/i,
  /cookie/i,
  /signature/i,
  /\botp\b|otpcode/i,
  /ssn/i,
  /^(lat|lng|lon|latitude|longitude|coords|coordinates|accuracy)$/i,
  /^(content|message|note|notes|text|body|reason|decisionreason)$/i,
  /(card|cvv|iban|routing|accountnumber)/i,
];

export function isSensitiveLogKey(key: string) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.startsWith("data:")) return `[data-url ${value.length} chars]`;
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`
      : value;
  }

  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return "[object]";

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactForLog(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveLogKey(key) ? REDACTED : redactForLog(entry, depth + 1);
  }
  return output;
}
