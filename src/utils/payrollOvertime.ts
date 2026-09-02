import { CalendarDay } from './timeLogEngine';
import { toCompanyDateStr } from './companyTimezone';

export const WEEKLY_OT_THRESHOLD_SECONDS = 40 * 3600;
export const WEEKLY_OT_PREMIUM_MULTIPLIER = 0.5;
export const WEEKLY_OVERAGE_FLAG_SECONDS = 43 * 3600;

export const WEEKLY_OT_EFFECTIVE_FROM = new Date('2026-08-16T06:00:00.000Z');

export interface WeeklyOvertimeResult {
  otPremiumSeconds: number;
  otPremiumPay: number;
  flaggedWeeks: { weekEndingDate: string; weekTotalSeconds: number }[];
}

export function computeWeeklyOvertime(
  calendar: Record<string, CalendarDay>,
  periodStart: Date,
  periodEnd: Date,
  hourlyRate: number | null,
  flagExempt: boolean = false,
): WeeklyOvertimeResult {
  const otEligible = periodStart >= WEEKLY_OT_EFFECTIVE_FROM;
  const startStr = toCompanyDateStr(periodStart);
  const endStr = toCompanyDateStr(periodEnd);

  let otPremiumSeconds = 0;
  const flaggedWeeks: { weekEndingDate: string; weekTotalSeconds: number }[] = [];

  for (const [dateStr, day] of Object.entries(calendar)) {
    if (day.weekTotalSeconds === undefined) continue;

    if (!flagExempt && day.weekTotalSeconds > WEEKLY_OVERAGE_FLAG_SECONDS) {
      flaggedWeeks.push({ weekEndingDate: dateStr, weekTotalSeconds: day.weekTotalSeconds });
    }

    if (dateStr < startStr || dateStr >= endStr) continue;
    if (!otEligible) continue;

    otPremiumSeconds += Math.max(0, day.weekTotalSeconds - WEEKLY_OT_THRESHOLD_SECONDS);
  }

  const otPremiumPay = hourlyRate ? (otPremiumSeconds / 3600) * hourlyRate * WEEKLY_OT_PREMIUM_MULTIPLIER : 0;

  return { otPremiumSeconds, otPremiumPay, flaggedWeeks };
}

export function sumRegularSecondsInPeriod(
  calendar: Record<string, CalendarDay>,
  periodStart: Date,
  periodEnd: Date,
): number {
  const startStr = toCompanyDateStr(periodStart);
  const endStr = toCompanyDateStr(periodEnd); // exclusive

  let total = 0;
  for (const [dateStr, day] of Object.entries(calendar)) {
    if (dateStr >= startStr && dateStr < endStr) {
      total += day.totalSeconds;
    }
  }
  return total;
}
