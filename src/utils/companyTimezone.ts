export const COMPANY_TZ = 'America/Denver';

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const ms = date.getTime();
  const values: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const wallClockAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour) % 24,
    Number(values.minute),
    Number(values.second),
  );
  return Math.round((wallClockAsUtc - (ms - (((ms % 1000) + 1000) % 1000))) / 60_000);
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

export function zoneMidnightUtc(dateStr: string, timeZone: string): Date {
  const wallMidnight = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  let guess = wallMidnight;
  for (let i = 0; i < 3; i++) guess = wallMidnight - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

export function companyOffsetMinutes(date: Date = new Date()): number {
  return zoneOffsetMinutes(date, COMPANY_TZ);
}

export function toCompanyLocal(date: Date): Date {
  return new Date(date.getTime() + companyOffsetMinutes(date) * 60_000);
}

export function toCompanyDateStr(date: Date): string {
  return toCompanyLocal(date).toISOString().split('T')[0];
}

export function getCompanyDayRange(dateStr: string): { start: Date; end: Date } {
  return {
    start: zoneMidnightUtc(dateStr, COMPANY_TZ),
    end: zoneMidnightUtc(addDaysToDateStr(dateStr, 1), COMPANY_TZ),
  };
}

export function getCompanyToday(now: Date = new Date()): { todayStr: string; start: Date; end: Date } {
  const todayStr = toCompanyDateStr(now);
  return { todayStr, ...getCompanyDayRange(todayStr) };
}

// Payout dates are fixed calendar days: the 20th (for the 1st-15th cutoff)
// and the 5th of the following month (for the 16th-end cutoff). Screenshots
// for a "blur until payout" account unblur starting 2 days before each payout
// date through the payout date itself, then re-blur the day after — used for
// a single account's privacy setting, independent of the wider Payout
// Calculator "available" window shown elsewhere on the TimeProof page.
export function isPayoutUnblurWindow(date: Date): boolean {
  const day = toCompanyLocal(date).getUTCDate();
  return (day >= 18 && day <= 20) || (day >= 3 && day <= 5);
}
