import { complianceExpiryItems, expiringSoonItems } from "../models/DriverProfile.model";

/*
 * Transportation's "Needs attention" list: the loads Dispatch should look at
 * now, gathered from signals that already exist elsewhere (proofs waiting for
 * confirmation, deadlines that have passed, the GPS-silence alert, driver
 * credentials). Pure, so the rules are testable without a database.
 */

export const ATTENTION_KINDS = [
  "proof_waiting",
  "late_delivery",
  "late_pickup",
  "gps_quiet",
  "document_expired",
  "document_expiring",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** A driver credential expiring within this many days is listed. */
export const DOCUMENT_ATTENTION_DAYS = 14;
/** At most this many items of each kind are returned (counts are complete). */
export const ATTENTION_ITEMS_PER_KIND = 25;

const LATE_PICKUP_STATUSES = new Set(["Assigned", "Accepted"]);
const LATE_DELIVERY_STATUSES = new Set(["Picked Up", "In-Transit"]);

export interface AttentionLoad {
  _id: unknown;
  loadNumber?: string;
  status?: string;
  organizationId?: string;
  assignedDriverId?: unknown;
  dispatchOwnerId?: unknown;
  dates?: { pickupDeadline?: unknown; deliveryDeadline?: unknown } | null;
  proofOfDelivery?: { submittedAt?: unknown } | null;
}

export interface AttentionLocation {
  userId: unknown;
  status?: string | null;
  offlineAlertSentAt?: Date | string | null;
  lastSeenAt?: Date | string | null;
  locationRecordedAt?: Date | string | null;
}

export type AttentionProfile = { userId: unknown } & NonNullable<Parameters<typeof expiringSoonItems>[0]>;

export interface AttentionItem {
  kind: AttentionKind;
  loadId: string;
  loadNumber: string;
  status: string;
  driverId?: string;
  driverName?: string;
  /** When the issue started: proof submitted, or last GPS position (ISO). */
  since?: string;
  /** The missed deadline or the credential's expiration day (YYYY-MM-DD). */
  date?: string;
  /** "CDL", "medical card" or "insurance". */
  credential?: string;
  daysLeft?: number;
}

export interface LoadAttention {
  counts: Record<AttentionKind, number>;
  items: AttentionItem[];
}

/** The calendar day of a date-only schedule field (stored as YYYY-MM-DD at UTC midnight). */
export function scheduleDayKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : "") : String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

const idOf = (value: unknown) => String((value as { _id?: unknown })?._id ?? value ?? "").trim();

export function buildLoadAttention(input: {
  /** This organization's loads with a driver: Assigned through In-Transit. */
  activeLoads: AttentionLoad[];
  /** This organization's loads with a delivery proof not yet confirmed. */
  proofLoads: AttentionLoad[];
  locations: AttentionLocation[];
  profiles: AttentionProfile[];
  driverNames: Map<string, string>;
  /** Whether this user may see the driver's GPS state on this load (dispatcher in charge or org admin). */
  canSeeGps: (load: AttentionLoad) => boolean;
  /** Today in the business time zone, YYYY-MM-DD. */
  todayKey: string;
  nowMs?: number;
}): LoadAttention {
  const { activeLoads, proofLoads, locations, profiles, driverNames, canSeeGps, todayKey } = input;
  const nowMs = input.nowMs ?? Date.now();
  const byKind = new Map<AttentionKind, AttentionItem[]>(ATTENTION_KINDS.map((kind) => [kind, []]));

  const base = (load: AttentionLoad): Omit<AttentionItem, "kind"> => {
    const driverId = idOf(load.assignedDriverId) || undefined;
    return {
      loadId: idOf(load._id),
      loadNumber: String(load.loadNumber ?? ""),
      status: String(load.status ?? ""),
      ...(driverId ? { driverId, driverName: driverNames.get(driverId) } : {}),
    };
  };

  for (const load of proofLoads) {
    byKind.get("proof_waiting")!.push({
      kind: "proof_waiting",
      ...base(load),
      since: isoOrUndefined(load.proofOfDelivery?.submittedAt),
    });
  }

  const locationByDriver = new Map(locations.map((location) => [idOf(location.userId), location]));
  const profileByDriver = new Map(profiles.map((profile) => [idOf(profile.userId), profile]));
  const firstLoadByDriver = new Map<string, AttentionLoad>();

  for (const load of activeLoads) {
    const status = String(load.status ?? "");
    const driverId = idOf(load.assignedDriverId);
    if (driverId && !firstLoadByDriver.has(driverId)) firstLoadByDriver.set(driverId, load);

    const pickupDay = scheduleDayKey(load.dates?.pickupDeadline);
    if (LATE_PICKUP_STATUSES.has(status) && pickupDay && pickupDay < todayKey) {
      byKind.get("late_pickup")!.push({ kind: "late_pickup", ...base(load), date: pickupDay });
    }
    const deliveryDay = scheduleDayKey(load.dates?.deliveryDeadline);
    if (LATE_DELIVERY_STATUSES.has(status) && deliveryDay && deliveryDay < todayKey) {
      byKind.get("late_delivery")!.push({ kind: "late_delivery", ...base(load), date: deliveryDay });
    }

    // The GPS-silence monitor marks the driver's location offline when it
    // alerts Dispatch (after its own exemptions); new GPS clears the mark.
    const location = driverId ? locationByDriver.get(driverId) : undefined;
    if (location?.offlineAlertSentAt && location.status === "offline" && canSeeGps(load)) {
      byKind.get("gps_quiet")!.push({
        kind: "gps_quiet",
        ...base(load),
        since: isoOrUndefined(location.locationRecordedAt ?? location.lastSeenAt),
      });
    }
  }

  // Credentials are per driver, shown once against one of their loads:
  // expired ones as Dispatch's compliance warning counts them, expiring ones
  // as the driver's Documents page shows them (Mountain Time calendar days).
  for (const [driverId, load] of firstLoadByDriver) {
    const profile = profileByDriver.get(driverId);
    const expired = complianceExpiryItems(profile, nowMs).filter((item) => item.expired);
    const expiredLabels = new Set(expired.map((item) => item.label));
    const expiring = expiringSoonItems(profile, DOCUMENT_ATTENTION_DAYS, nowMs).filter(
      (item) => !expiredLabels.has(item.label),
    );
    for (const [kind, items] of [
      ["document_expired", expired],
      ["document_expiring", expiring],
    ] as const) {
      for (const item of items) {
        byKind.get(kind)!.push({
          kind,
          ...base(load),
          credential: item.label,
          date: item.date,
          daysLeft: item.daysLeft,
        });
      }
    }
  }

  const bySince = (a: AttentionItem, b: AttentionItem) => (a.since ?? "~").localeCompare(b.since ?? "~");
  const byDate = (a: AttentionItem, b: AttentionItem) => (a.date ?? "~").localeCompare(b.date ?? "~");
  byKind.get("proof_waiting")!.sort(bySince);
  byKind.get("gps_quiet")!.sort(bySince);
  byKind.get("late_pickup")!.sort(byDate);
  byKind.get("late_delivery")!.sort(byDate);
  byKind.get("document_expired")!.sort(byDate);
  byKind.get("document_expiring")!.sort(byDate);

  const counts = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, byKind.get(kind)!.length])) as Record<
    AttentionKind,
    number
  >;
  const items = ATTENTION_KINDS.flatMap((kind) => byKind.get(kind)!.slice(0, ATTENTION_ITEMS_PER_KIND));
  return { counts, items };
}
