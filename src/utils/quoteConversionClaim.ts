/**
 * One "Convert to load" at a time per quote (2026-11-16). Two staff members,
 * or two tabs, pressing Convert at the same moment would otherwise each create
 * a load. The request that claims the quote converts it; the claim is released
 * when that request ends and lapses by itself after a minute if it never does.
 */
export const QUOTE_CONVERSION_CLAIM_MS = 60_000;

export const QUOTE_BEING_CONVERTED =
  "Someone else is turning this quote into a load right now. Wait a moment, then refresh to open the new load.";

/** The quote, in this dealership, with no conversion in progress right now. */
export function quoteConversionClaimFilter(quoteId: unknown, organizationId: string, now: Date) {
  return {
    _id: quoteId,
    organizationId,
    $or: [{ convertingUntil: { $exists: false } }, { convertingUntil: null }, { convertingUntil: { $lte: now } }],
  };
}

export function quoteConversionClaimUntil(now: Date): Date {
  return new Date(now.getTime() + QUOTE_CONVERSION_CLAIM_MS);
}
