/**
 * The Quotes tab counts (2026-11-16): how many of the dealership's quotes are
 * in each status, counted on the server. The website used to count only the
 * newest 100 quotes it had downloaded, so the counts were too low once a
 * dealership had more.
 */
export type QuoteStatusCounts = { all: number; pending: number; accepted: number; booked: number; rejected: number };

export function quoteStatusCounts(rows: Array<{ _id?: unknown; count?: unknown }>): QuoteStatusCounts {
  const counts: QuoteStatusCounts = { all: 0, pending: 0, accepted: 0, booked: 0, rejected: 0 };
  for (const row of rows) {
    const count = Math.max(0, Math.floor(Number(row?.count) || 0));
    counts.all += count;
    const status = String(row?._id ?? "");
    if (status === "pending" || status === "accepted" || status === "booked" || status === "rejected") {
      counts[status] += count;
    }
  }
  return counts;
}
