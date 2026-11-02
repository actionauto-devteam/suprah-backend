import mongoose from "mongoose";
import type { calendar_v3 } from "googleapis";
import Load from "../models/Load.model";
import User from "../models/User.model";
import CrmUser from "../models/CrmUser.model";
import googleCalendarService, { SHIPMENT_EVENT_PROPERTY } from "./googleCalendar.service";
import config from "../config";
import logger from "../utils/logger";

/*
 * Shipments on the Suprah Calendar and in Google Calendar (decided 2026-10-30):
 * each live load's planned pickup window and delivery deadline. Admins see
 * all of the dealership's live loads on the Suprah Calendar; everyone else
 * sees only the loads they're dispatching. Each dispatcher's own connected
 * Google Calendar gets the loads they dispatch, one-way: edits made in Google
 * never change the load. Events carry the load number, car and cities, never
 * customer names, phones, emails, street addresses or the driver. A delivered
 * or cancelled load has no events.
 */

export const FINISHED_LOAD_STATUSES = ["Delivered", "Cancelled"];
/** The longest range one Suprah Calendar request may ask for. */
export const CALENDAR_RANGE_MAX_DAYS = 120;
const LIST_LIMIT = 500;

export type ShipmentEntryKind = "pickup" | "delivery";

export interface ShipmentCalendarEntry {
  kind: ShipmentEntryKind;
  title: string;
  /** Calendar days, "YYYY-MM-DD", both inclusive. */
  startDate: string;
  endDate: string;
}

/** A schedule date (stored at UTC midnight) as its calendar day. */
export const calendarDay = (value: unknown): string => {
  if (!value) return "";
  const date = new Date(value as string | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
};

const nextDay = (day: string): string => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const clean = (value: unknown, max = 60) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** "2021 Toyota Camry", or "2021 Toyota Camry + 1 more" for a load with several cars. */
export function shipmentCarLabel(load: any): string {
  const vehicles = Array.isArray(load?.vehicles) ? load.vehicles : [];
  if (!vehicles.length) return "";
  const first = vehicles[0] ?? {};
  const label = [first.year, clean(first.make), clean(first.model)].filter(Boolean).join(" ");
  return vehicles.length > 1 ? `${label || "Vehicle"} + ${vehicles.length - 1} more` : label;
}

/** "Orem, UT → Denver, CO": cities only, never street addresses. */
export function shipmentRouteLabel(load: any): string {
  const place = (stop: any) => [clean(stop?.city), clean(stop?.state, 3).toUpperCase()].filter(Boolean).join(", ");
  const from = place(load?.pickupLocation);
  const to = place(load?.deliveryLocation);
  return from && to ? `${from} → ${to}` : from || to;
}

/** A live load's pickup window and delivery deadline. Nothing for a delivered or cancelled load. */
export function shipmentCalendarEntries(load: any): ShipmentCalendarEntry[] {
  if (!load || FINISHED_LOAD_STATUSES.includes(String(load.status))) return [];
  const label = [clean(load.loadNumber, 40), shipmentCarLabel(load), shipmentRouteLabel(load)].filter(Boolean).join(" · ");
  const entries: ShipmentCalendarEntry[] = [];
  const first = calendarDay(load.dates?.firstAvailable);
  const pickupBy = calendarDay(load.dates?.pickupDeadline);
  if (first || pickupBy) {
    const start = first || pickupBy;
    const end = pickupBy && pickupBy >= start ? pickupBy : start;
    entries.push({ kind: "pickup", title: `Pickup window: ${label}`, startDate: start, endDate: end });
  }
  const deliverBy = calendarDay(load.dates?.deliveryDeadline);
  if (deliverBy) entries.push({ kind: "delivery", title: `Delivery deadline: ${label}`, startDate: deliverBy, endDate: deliverBy });
  return entries;
}

export interface CalendarShipmentItem extends ShipmentCalendarEntry {
  loadId: string;
  loadNumber: string;
  status: string;
}

/**
 * Shipment entries for the Suprah Calendar between two instants. Admins get
 * all of the dealership's live loads; anyone else only the loads they're
 * dispatching (none, for staff who don't dispatch).
 */
export async function listCalendarShipments(input: {
  organizationId: string;
  userId: string;
  isAdmin: boolean;
  from: unknown;
  to: unknown;
}): Promise<CalendarShipmentItem[]> {
  const from = new Date(String(input.from ?? ""));
  const to = new Date(String(input.to ?? ""));
  if (!input.organizationId || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) return [];
  const maxEnd = new Date(from.getTime() + CALENDAR_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000);
  const end = to > maxEnd ? maxEnd : to;
  if (!input.isAdmin && !mongoose.Types.ObjectId.isValid(input.userId)) return [];

  // A day of slack each side: schedule dates sit at UTC midnight.
  const lower = new Date(from.getTime() - 24 * 60 * 60 * 1000);
  const upper = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const loads = await Load.find({
    organizationId: input.organizationId,
    status: { $nin: FINISHED_LOAD_STATUSES },
    ...(input.isAdmin ? {} : { dispatchOwnerId: input.userId }),
    $or: [
      { "dates.deliveryDeadline": { $gte: lower, $lte: upper } },
      { "dates.firstAvailable": { $gte: lower, $lte: upper } },
      { "dates.pickupDeadline": { $gte: lower, $lte: upper } },
      { "dates.firstAvailable": { $lte: upper }, "dates.pickupDeadline": { $gte: lower } },
    ],
  })
    .select("loadNumber status dates vehicles.year vehicles.make vehicles.model pickupLocation.city pickupLocation.state deliveryLocation.city deliveryLocation.state")
    .sort({ "dates.firstAvailable": 1 })
    .limit(LIST_LIMIT)
    .lean<any[]>();

  const fromDay = calendarDay(lower);
  const toDay = calendarDay(upper);
  return loads.flatMap((load) =>
    shipmentCalendarEntries(load)
      .filter((entry) => entry.endDate >= fromDay && entry.startDate <= toDay)
      .map((entry) => ({ ...entry, loadId: String(load._id), loadNumber: String(load.loadNumber ?? ""), status: String(load.status ?? "") })),
  );
}

// ─── Google Calendar (one-way) ────────────────────────────────────────────────

/** The Google event for one entry: all-day, shown as free time, marked as a shipment. */
export function googleShipmentEvent(entry: ShipmentCalendarEntry, loadId: string): calendar_v3.Schema$Event {
  const base = String(config.frontendUrl ?? "").replace(/\/+$/, "");
  return {
    summary: entry.title,
    description: [
      base ? `Open the load in Suprah AI: ${base}/transportation/load/${encodeURIComponent(loadId)}` : "",
      "Added by Suprah AI Transportation. Change dates on the load in Suprah AI; changes made here are replaced.",
    ].filter(Boolean).join("\n"),
    start: { date: entry.startDate },
    end: { date: nextDay(entry.endDate) },
    transparency: "transparent",
    extendedProperties: { private: { [SHIPMENT_EVENT_PROPERTY]: loadId, suprahShipmentKind: entry.kind } },
  };
}

/** The dispatcher's CRM account when it has Google Calendar connected, else null. */
export async function dispatcherGoogleCrmUserId(organizationId: string, dispatchOwnerId: unknown): Promise<string | null> {
  const id = String(dispatchOwnerId ?? "");
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const user = await User.findOne({ _id: id, organizationId, isActive: true }).select("email").lean<{ email?: string }>();
  const email = String(user?.email ?? "").trim().toLowerCase();
  if (!email) return null;
  const crmUser = await CrmUser.findOne({ email, organizationId, isActive: true })
    .select("_id googleCalendar.calendarConnected")
    .lean<{ _id: mongoose.Types.ObjectId; googleCalendar?: { calendarConnected?: boolean } }>();
  return crmUser?.googleCalendar?.calendarConnected ? String(crmUser._id) : null;
}

export type GoogleSyncResult = "unchanged" | "synced" | "failed" | "busy";

const LOCK_MS = 2 * 60 * 1000;

/**
 * Brings one load's Google events in line with the load: adds, updates,
 * moves to a new dispatcher or removes them. Writes to Google only when
 * something changed. Never throws.
 */
export async function reconcileLoadGoogleEvents(load: any): Promise<GoogleSyncResult> {
  const loadId = String(load?._id ?? "");
  const organizationId = String(load?.organizationId ?? "");
  if (!mongoose.Types.ObjectId.isValid(loadId) || !organizationId) return "unchanged";
  try {
    const live = !FINISHED_LOAD_STATUSES.includes(String(load.status));
    const owner = live && load.dispatchOwnerId ? await dispatcherGoogleCrmUserId(organizationId, load.dispatchOwnerId) : null;
    const entries = owner ? shipmentCalendarEntries(load) : [];
    const fingerprint = owner && entries.length ? JSON.stringify({ owner, entries }) : "";
    const current = load.calendarSync;
    const currentOwner = current?.crmUserId ? String(current.crmUserId) : null;
    const currentEvents: Array<{ kind: ShipmentEntryKind; eventId: string }> = Array.isArray(current?.events) ? current.events : [];
    if (fingerprint === String(current?.fingerprint ?? "") && currentEvents.length === entries.length) return "unchanged";

    // One server at a time per load.
    const now = new Date();
    const claimed = await Load.updateOne(
      { _id: loadId, $or: [{ calendarSyncLockedUntil: { $exists: false } }, { calendarSyncLockedUntil: null }, { calendarSyncLockedUntil: { $lte: now } }] },
      { $set: { calendarSyncLockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { timestamps: false },
    );
    if (!claimed.modifiedCount) return "busy";

    try {
      // Remove events from a calendar that no longer has this load, or kinds no longer wanted.
      for (const event of currentEvents) {
        const keep = currentOwner === owner && entries.some((entry) => entry.kind === event.kind);
        if (keep || !currentOwner) continue;
        const removed = await googleCalendarService.deleteShipmentEvent({ type: "crmUser", id: currentOwner }, event.eventId);
        if (!removed) return "failed"; // nothing saved; tried again on a later run
      }

      let failed = false;
      const nextEvents: Array<{ kind: ShipmentEntryKind; eventId: string }> = [];
      for (const entry of entries) {
        const existing = currentOwner === owner ? currentEvents.find((event) => event.kind === entry.kind) : undefined;
        const eventId = await googleCalendarService.upsertShipmentEvent(
          { type: "crmUser", id: owner as string },
          existing?.eventId ?? null,
          googleShipmentEvent(entry, loadId),
        );
        if (eventId) nextEvents.push({ kind: entry.kind, eventId });
        else {
          failed = true;
          if (existing) nextEvents.push(existing);
        }
      }

      const update = owner && nextEvents.length
        ? { $set: { calendarSync: { crmUserId: owner, events: nextEvents, fingerprint: failed ? "" : fingerprint, syncedAt: new Date() } } }
        : { $unset: { calendarSync: "" } };
      await Load.updateOne({ _id: loadId }, update, { timestamps: false });
      return failed ? "failed" : "synced";
    } finally {
      await Load.updateOne({ _id: loadId }, { $unset: { calendarSyncLockedUntil: "" } }, { timestamps: false });
    }
  } catch (err) {
    logger.error({ err, loadId }, "Non-fatal: could not update a load's Google Calendar events");
    return "failed";
  }
}

const SYNC_FIELDS =
  "+calendarSync organizationId loadNumber status dispatchOwnerId dates vehicles.year vehicles.make vehicles.model pickupLocation.city pickupLocation.state deliveryLocation.city deliveryLocation.state";
const SYNC_BATCH = 200;

/**
 * One run of the Google sync: loads changed since the last run, and every
 * live dispatched load on a full pass (picks up newly connected calendars
 * and retries earlier failures).
 */
export async function runCalendarShipmentSync(since: Date, fullPass: boolean): Promise<{ checked: number; synced: number; failed: number }> {
  const tracked = { "calendarSync.crmUserId": { $exists: true } };
  const filter = fullPass
    ? { $or: [{ status: { $nin: FINISHED_LOAD_STATUSES }, dispatchOwnerId: { $ne: null } }, tracked] }
    : { updatedAt: { $gte: since }, $or: [{ dispatchOwnerId: { $ne: null } }, tracked] };
  const loads = await Load.find(filter).select(SYNC_FIELDS).sort({ updatedAt: -1 }).limit(SYNC_BATCH).lean<any[]>();
  let synced = 0;
  let failed = 0;
  for (const load of loads) {
    const result = await reconcileLoadGoogleEvents(load);
    if (result === "synced") synced++;
    if (result === "failed") failed++;
  }
  return { checked: loads.length, synced, failed };
}
