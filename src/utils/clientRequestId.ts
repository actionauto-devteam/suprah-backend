/**
 * A client-generated request id (letters, digits, "-" and "_", 8-100 chars),
 * sent with a message or alert so a retry of the same send isn't delivered
 * twice. Returns null when missing or malformed.
 */
export function parseClientRequestId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{8,100}$/.test(id) ? id : null;
}
