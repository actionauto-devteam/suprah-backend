// Weekly overtime math for the Utah team (per Erik Schofield's directives, 2026-08-07).
// Reuses buildCalendarMap's existing Sun-Sat weekTotalSeconds (stamped on the Saturday
// key by attachWeekTotals in timeLogEngine.ts) instead of re-deriving week boundaries.
import { CalendarDay } from './timeLogEngine';
import { toCompanyDateStr } from './companyTimezone';

export const WEEKLY_OT_THRESHOLD_SECONDS = 40 * 3600;
// Extra half on top of the base rate — the base 1x is already paid via the period's regular totalSeconds.
export const WEEKLY_OT_PREMIUM_MULTIPLIER = 0.5;
// Erik's "heads up" threshold — separate from the 40h OT threshold, gives buffer for minor variance.
export const WEEKLY_OVERAGE_FLAG_SECONDS = 43 * 3600;

// OT applies going forward only — do not recalculate periods before this date
// (Erik: "let's just do it moving forward, I don't want to complicate anything").
// Set to the start of the Aug 16-31, 2026 pay period (confirmed with user 2026-08-07).
export const WEEKLY_OT_EFFECTIVE_FROM = new Date('2026-08-16T06:00:00.000Z');

export interface WeeklyOvertimeResult {
  otPremiumSeconds: number;
  otPremiumPay: number;
  flaggedWeeks: { weekEndingDate: string; weekTotalSeconds: number }[];
}

// calendar keys are "YYYY-MM-DD" company-local dates (same toLocalDateStr formula as
// toCompanyDateStr below), so date-range checks can compare the strings directly.
export function computeWeeklyOvertime(
  calendar: Record<string, CalendarDay>,
  periodStart: Date,
  periodEnd: Date,
  hourlyRate: number | null,
): WeeklyOvertimeResult {
  const otEligible = periodStart >= WEEKLY_OT_EFFECTIVE_FROM;
  const startStr = toCompanyDateStr(periodStart);
  const endStr = toCompanyDateStr(periodEnd); // exclusive

  let otPremiumSeconds = 0;
  const flaggedWeeks: { weekEndingDate: string; weekTotalSeconds: number }[] = [];

  for (const [dateStr, day] of Object.entries(calendar)) {
    if (day.weekTotalSeconds === undefined) continue;

    if (day.weekTotalSeconds > WEEKLY_OVERAGE_FLAG_SECONDS) {
      flaggedWeeks.push({ weekEndingDate: dateStr, weekTotalSeconds: day.weekTotalSeconds });
    }

    // Only pay OT for a week once its Saturday (this key) has actually landed inside
    // the period being paid out — a week whose Saturday falls in the NEXT period is
    // left alone here and picked up when that next period is computed.
    if (dateStr < startStr || dateStr >= endStr) continue;
    if (!otEligible) continue;

    otPremiumSeconds += Math.max(0, day.weekTotalSeconds - WEEKLY_OT_THRESHOLD_SECONDS);
  }

  const otPremiumPay = hourlyRate ? (otPremiumSeconds / 3600) * hourlyRate * WEEKLY_OT_PREMIUM_MULTIPLIER : 0;

  return { otPremiumSeconds, otPremiumPay, flaggedWeeks };
}

// Sums a calendar's totalSeconds for only the days that fall within [periodStart, periodEnd) —
// needed once the TimeLog query window is widened with a lookback for weekly OT context.
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
