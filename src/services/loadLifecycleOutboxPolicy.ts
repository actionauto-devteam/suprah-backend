/**
 * Retry / dead-letter policy for the Load lifecycle outbox. Kept free of
 * database and model imports so it can be unit tested in isolation.
 */

/** Claims per event before it is dead-lettered (~2.5h with the backoff below). */
export const OUTBOX_MAX_ATTEMPTS = 12;

/** Thrown by a delivery handler when retrying can never succeed. */
export class NonRetryableOutboxError extends Error {
  readonly nonRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = "NonRetryableOutboxError";
  }
}

export function outboxRetryDelayMs(attempts: number) {
  const exponent = Math.max(0, Math.min(8, attempts - 1));
  return Math.min(15 * 60_000, 5_000 * 2 ** exponent);
}

/**
 * Errors that will fail identically on every retry: invalid notification or
 * activity types, missing recipients, malformed ids. Timeouts (408), rate
 * limits (429) and 5xx/infrastructure errors stay retryable.
 */
export function isNonRetryableOutboxError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    nonRetryable?: unknown;
    name?: unknown;
    statusCode?: unknown;
  };

  if (candidate.nonRetryable === true) return true;

  const name = String(candidate.name ?? "");
  if (["ValidationError", "CastError", "StrictModeError", "BSONError"].includes(name)) {
    return true;
  }

  const status = Number(candidate.statusCode);
  return (
    Number.isFinite(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export type OutboxFailureDecision =
  | { action: "retry"; delayMs: number }
  | { action: "dead_letter"; reason: "non_retryable" | "max_attempts" };

/** `attempts` is the attempt count after the failed claim was recorded. */
export function decideOutboxFailure(
  error: unknown,
  attempts: number,
): OutboxFailureDecision {
  if (isNonRetryableOutboxError(error)) {
    return { action: "dead_letter", reason: "non_retryable" };
  }
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    return { action: "dead_letter", reason: "max_attempts" };
  }
  return { action: "retry", delayMs: outboxRetryDelayMs(attempts) };
}
