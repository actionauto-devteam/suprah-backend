// Company-local timezone (Mountain Time, MDT/UTC-6) used to bucket TimeProof
// and locator activity into calendar days consistently across features.
// Mirrors the same offset used inline in generalTimeclock/crmTimeproof/crm controllers.
export const COMPANY_TZ_OFFSET_MINUTES = -360;

export function toCompanyDateStr(date: Date): string {
  return new Date(date.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000)
    .toISOString()
    .split('T')[0];
}

// Given a YYYY-MM-DD calendar date in company-local time, returns the UTC
// instants for that day's local midnight-to-midnight window.
export function getCompanyDayRange(dateStr: string): { start: Date; end: Date } {
  const startUtcMs = new Date(dateStr + 'T00:00:00.000Z').getTime() - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  return { start: new Date(startUtcMs), end: new Date(startUtcMs + 24 * 60 * 60 * 1000) };
}

// Payout dates are fixed calendar days: the 20th (for the 1st-15th cutoff)
// and the 5th of the following month (for the 16th-end cutoff). Screenshots
// for a "blur until payout" account unblur starting 2 days before each payout
// date through the payout date itself, then re-blur the day after — used for
// a single account's privacy setting, independent of the wider Payout
// Calculator "available" window shown elsewhere on the TimeProof page.
export function isPayoutUnblurWindow(date: Date): boolean {
  const local = new Date(date.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000);
  const day = local.getUTCDate();
  return (day >= 18 && day <= 20) || (day >= 3 && day <= 5);
}
