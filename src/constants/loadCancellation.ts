/**
 * Why staff cancelled a load. The frontend mirrors these in
 * src/lib/load-cancellation.ts. Change both together.
 */
export const LOAD_CANCELLATION_REASONS = [
  "customer_cancelled",
  "vehicle_unavailable",
  "duplicate_load",
  "price_not_agreed",
  "other",
] as const;

export type LoadCancellationReason = (typeof LOAD_CANCELLATION_REASONS)[number];

export const LOAD_CANCELLATION_REASON_LABELS: Readonly<Record<LoadCancellationReason, string>> = {
  customer_cancelled: "Customer cancelled",
  vehicle_unavailable: "Vehicle sold or unavailable",
  duplicate_load: "Duplicate load",
  price_not_agreed: "Price not agreed",
  other: "Other",
};

/** "Other" needs a note at least this long. */
export const LOAD_CANCELLATION_NOTE_MIN = 3;
export const LOAD_CANCELLATION_NOTE_MAX = 500;

export function isLoadCancellationReason(value: unknown): value is LoadCancellationReason {
  return (LOAD_CANCELLATION_REASONS as readonly string[]).includes(String(value ?? ""));
}
