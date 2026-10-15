/**
 * Vehicle condition reports: the driver's photos and damage notes for each
 * vehicle at pickup and at delivery, plus the customer's signature at
 * delivery. Shared by the Load model and the condition report endpoints; the
 * frontend mirrors the lists in src/lib/condition-report.ts.
 */

export const CONDITION_STOPS = ["pickup", "delivery"] as const;
export type ConditionStop = (typeof CONDITION_STOPS)[number];

/** Areas of the vehicle the driver can mark as damaged on the outline. */
export const CONDITION_AREAS = [
  "front",
  "hood",
  "roof",
  "trunk",
  "rear",
  "left_front",
  "left_rear",
  "right_front",
  "right_rear",
  "glass",
  "wheels",
  "interior",
] as const;

export const CONDITION_DAMAGE_TYPES = [
  "scratch",
  "dent",
  "chip",
  "crack",
  "broken_or_missing",
  "other",
] as const;

/** Most photos kept per vehicle at each stop. */
export const CONDITION_PHOTOS_PER_VEHICLE = 12;

/** Load statuses during which the driver can add to each stop's report. */
export const CONDITION_STOP_STATUSES: Record<ConditionStop, readonly string[]> = {
  // Before loading, and right after (until the route starts).
  pickup: ["Accepted", "Picked Up"],
  // At the delivery stop, until the load is delivered.
  delivery: ["Picked Up", "In-Transit"],
};

/** A drawn signature PNG, as a data URL, of at most this many characters. */
export const SIGNATURE_DATA_URL_MAX_LENGTH = 300_000;
