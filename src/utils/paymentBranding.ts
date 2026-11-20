/**
 * The dealership's name on the customer's card statement (2026-11-21).
 * Stripe joins this to Suprah's own statement name, and the whole line is at
 * most 22 characters, so it is kept short: capital letters, numbers and
 * spaces only, up to 10 characters, with at least one letter.
 */
export function statementSuffixFor(name: string | null | undefined): string | undefined {
  const cleaned = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10)
    .trim();
  return /[A-Z]/.test(cleaned) ? cleaned : undefined;
}
