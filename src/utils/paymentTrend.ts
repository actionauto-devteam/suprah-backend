/**
 * Revenue Trend on the staff Payments page (2026-11-19): money kept from paid
 * payments in each of the last few months. Months are calendar months in UTC,
 * the same as the CRM dashboard's revenue chart.
 */

export type MonthKey = { year: number; month: number };
export type MonthlyRevenue = MonthKey & { revenue: number };

/** The last `count` months up to and including the one `now` is in, oldest first. */
export function lastMonths(now: Date, count: number): { months: MonthKey[]; start: Date } {
  const months: MonthKey[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  const first = months[0];
  return { months, start: new Date(Date.UTC(first.year, first.month - 1, 1)) };
}

/** One entry per month, with 0 for months that had no paid payments. */
export function fillMonthlyRevenue(
  months: MonthKey[],
  rows: Array<{ _id: MonthKey; revenue: number }>,
): MonthlyRevenue[] {
  const byKey = new Map(rows.map((r) => [`${r._id.year}-${r._id.month}`, Number(r.revenue) || 0]));
  return months.map((m) => ({
    ...m,
    revenue: Math.round((byKey.get(`${m.year}-${m.month}`) ?? 0) * 100) / 100,
  }));
}
