import { complianceExpiryItems, expiringSoonItems } from "../models/DriverProfile.model";

/*
 * Transportation's "Needs attention" list: the loads Dispatch should look at
 * now, gathered from signals that already exist elsewhere (proofs waiting for
 * confirmation, deadlines that have passed, loads with no driver on pickup
 * day, assignments the driver hasn't accepted, driver requests waiting for an
 * answer, customer shipping requests, quotes and loads before pickup whose
 * vehicle was removed from inventory, the GPS-silence alert, driver
 * credentials). Pure, so the rules are testable without a database.
 */

export const ATTENTION_KINDS = [
  "proof_waiting",
  "late_delivery",
  "late_pickup",
  "unassigned_pickup",
  "not_accepted",
  "release_request",
  "gps_quiet",
  "load_request",
  "customer_request",
  "vehicle_removed",
  "document_expired",
  "document_expiring",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** A driver credential expiring within this many days is listed. */
export const DOCUMENT_ATTENTION_DAYS = 14;
/** At most this many items of each kind are returned (counts are complete). */
export const ATTENTION_ITEMS_PER_KIND = 25;
/** An assignment the driver hasn't accepted is listed after this long. */
export const NOT_ACCEPTED_AFTER_MS = 2 * 60 * 60 * 1000;

const LATE_PICKUP_STATUSES = new Set(["Assigned", "Accepted"]);
const LATE_DELIVERY_STATUSES = new Set(["Picked Up", "In-Transit"]);
/** Loads that still need a driver. */
const UNASSIGNED_STATUSES = new Set(["Draft", "Posted"]);

export interface AttentionLoad {
  _id: unknown;
  loadNumber?: string;
  status?: string;
  organizationId?: string;
  assignedDriverId?: unknown;
  dispatchOwnerId?: unknown;
  assignedAt?: unknown;
  dates?: { pickupDeadline?: unknown; deliveryDeadline?: unknown } | null;
  proofOfDelivery?: { submittedAt?: unknown } | null;
  driverRequests?: Array<{ driverId?: unknown; requestedAt?: unknown }> | null;
  vehicles?: Array<{ vehicleId?: unknown; year?: unknown; make?: unknown; model?: unknown }> | null;
}

/** A quote or a load not yet picked up whose inventory vehicle was removed. */
export interface AttentionRemovedVehicle {
  load?: AttentionLoad;
  quote?: AttentionQuote;
  vehicleName?: string;
}

/** A driver's pending request to be released from one of this dealership's loads. */
export interface AttentionReleaseRequest {
  loadId: unknown;
  driverId: unknown;
  dispatcherId?: unknown;
  priority?: string | null;
  requestedAt?: unknown;
}

/** A waiting quote: a customer's shipping request, or a staff quote. */
export interface AttentionQuote {
  _id: unknown;
  firstName?: string;
  lastName?: string;
  vehicleName?: string;
  createdAt?: unknown;
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
  /** Drivers waiting for an answer on this load (load_request). */
  requestCount?: number;
  /** The driver marked their release request as an emergency. */
  emergency?: boolean;
  /** A quote (customer request or removed vehicle): no load yet, so loadId is "". */
  quoteId?: string;
  customerName?: string;
  vehicleName?: string;
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
  /** Draft and Posted loads with no driver whose pickup day is today or earlier. */
  unassignedLoads?: AttentionLoad[];
  /** Posted loads with driver requests waiting (already limited to who may review them). */
  requestedLoads?: AttentionLoad[];
  /** Pending release requests (already limited to who may review them). */
  releaseRequests?: AttentionReleaseRequest[];
  /** Customer shipping requests still waiting for the dealership. */
  customerRequests?: AttentionQuote[];
  /** Waiting quotes and loads before pickup whose vehicle left inventory. */
  removedVehicles?: AttentionRemovedVehicle[];
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

    // Assigned but not accepted after a while: the driver may have missed it.
    const assignedAt = isoOrUndefined(load.assignedAt);
    if (status === "Assigned" && assignedAt && nowMs - Date.parse(assignedAt) >= NOT_ACCEPTED_AFTER_MS) {
      byKind.get("not_accepted")!.push({ kind: "not_accepted", ...base(load), since: assignedAt });
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

  // No driver yet and the pickup day has come.
  for (const load of input.unassignedLoads ?? []) {
    const pickupDay = scheduleDayKey(load.dates?.pickupDeadline);
    if (UNASSIGNED_STATUSES.has(String(load.status ?? "")) && !idOf(load.assignedDriverId) && pickupDay && pickupDay <= todayKey) {
      byKind.get("unassigned_pickup")!.push({ kind: "unassigned_pickup", ...base(load), date: pickupDay });
    }
  }

  // Drivers waiting for an answer on a load they asked for.
  for (const load of input.requestedLoads ?? []) {
    const requests = Array.isArray(load.driverRequests) ? load.driverRequests : [];
    if (load.status !== "Posted" || requests.length === 0) continue;
    const earliest = requests
      .map((request) => isoOrUndefined(request?.requestedAt))
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    byKind.get("load_request")!.push({
      kind: "load_request",
      ...base(load),
      requestCount: requests.length,
      since: earliest,
    });
  }

  // A driver asked to be released from a load they have.
  const activeById = new Map(activeLoads.map((load) => [idOf(load._id), load]));
  for (const request of input.releaseRequests ?? []) {
    const load = activeById.get(idOf(request.loadId));
    if (!load) continue;
    const driverId = idOf(request.driverId);
    byKind.get("release_request")!.push({
      kind: "release_request",
      ...base(load),
      ...(driverId ? { driverId, driverName: driverNames.get(driverId) } : {}),
      since: isoOrUndefined(request.requestedAt),
      emergency: request.priority === "emergency",
    });
  }

  // Customer shipping requests from the customer portal, still waiting.
  for (const quote of input.customerRequests ?? []) {
    const customerName = [quote.firstName, quote.lastName].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
    byKind.get("customer_request")!.push({
      kind: "customer_request",
      loadId: "",
      loadNumber: "",
      status: "pending",
      quoteId: idOf(quote._id),
      customerName: customerName || "A customer",
      vehicleName: String(quote.vehicleName ?? "").trim() || undefined,
      since: isoOrUndefined(quote.createdAt),
    });
  }

  // A quote or a load not yet picked up whose vehicle was removed from inventory.
  for (const removed of input.removedVehicles ?? []) {
    if (removed.load) {
      byKind.get("vehicle_removed")!.push({
        kind: "vehicle_removed",
        ...base(removed.load),
        vehicleName: removed.vehicleName || undefined,
      });
    } else if (removed.quote) {
      const quote = removed.quote;
      const customerName = [quote.firstName, quote.lastName].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
      byKind.get("vehicle_removed")!.push({
        kind: "vehicle_removed",
        loadId: "",
        loadNumber: "",
        status: "pending",
        quoteId: idOf(quote._id),
        customerName: customerName || "A customer",
        vehicleName: removed.vehicleName || String(quote.vehicleName ?? "").trim() || undefined,
        since: isoOrUndefined(quote.createdAt),
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
  byKind.get("unassigned_pickup")!.sort(byDate);
  byKind.get("not_accepted")!.sort(bySince);
  byKind.get("load_request")!.sort(bySince);
  byKind.get("customer_request")!.sort(bySince);
  // Emergencies first, then the longest waiting.
  byKind.get("release_request")!.sort((a, b) => Number(Boolean(b.emergency)) - Number(Boolean(a.emergency)) || bySince(a, b));
  byKind.get("document_expired")!.sort(byDate);
  byKind.get("document_expiring")!.sort(byDate);

  const counts = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, byKind.get(kind)!.length])) as Record<
    AttentionKind,
    number
  >;
  const items = ATTENTION_KINDS.flatMap((kind) => byKind.get(kind)!.slice(0, ATTENTION_ITEMS_PER_KIND));
  return { counts, items };
}
