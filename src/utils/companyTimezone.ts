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
