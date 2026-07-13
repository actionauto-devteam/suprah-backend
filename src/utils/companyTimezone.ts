export const COMPANY_TZ_OFFSET_MINUTES = -360;

export function toCompanyDateStr(date: Date): string {
  return new Date(date.getTime() + COMPANY_TZ_OFFSET_MINUTES * 60_000)
    .toISOString()
    .split('T')[0];
}

export function getCompanyDayRange(dateStr: string): { start: Date; end: Date } {
  const startUtcMs = new Date(dateStr + 'T00:00:00.000Z').getTime() - COMPANY_TZ_OFFSET_MINUTES * 60_000;
  return { start: new Date(startUtcMs), end: new Date(startUtcMs + 24 * 60 * 60 * 1000) };
}
