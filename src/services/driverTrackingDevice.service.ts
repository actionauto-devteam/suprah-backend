import crypto from "crypto";
import { getTraccarConfig } from "../config/traccar";
import DriverTrackingDevice, { IDriverTrackingDevice } from "../models/DriverTrackingDevice.model";
import User from "../models/User.model";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";
import { getDriverGpsTrackingLoads } from "./driverLocationAccess.service";
import { TraccarApiError, addTraccarDevice, disableTraccarDevice } from "./traccar.service";

/*
 * Linking a driver's phone (Traccar Client) to their account. See
 * models/DriverTrackingDevice.model.ts for the business rules.
 */

/** Suprah hasn't received a Traccar position for this long during an active load: warn the driver. */
export const TRACCAR_SILENCE_WARNING_MS = 5 * 60_000;
/** A phone still reporting this recently with no active load gets "you can turn it off". */
const TURN_OFF_REMINDER_WINDOW_MS = 2 * 60 * 60_000;

export const PHONE_TRACKING_UNAVAILABLE =
  "Phone tracking isn't available yet. Your company is still setting it up; your location keeps being shared from the Driver Portal.";

/** 96 random bits, letters and digits only (Traccar Client's identifier field). */
export function generateDeviceIdentifier(): string {
  return `SPR${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

async function currentLink(driverId: string) {
  return DriverTrackingDevice.findOne({ driverId, isCurrent: true });
}

function syncFailure(error: unknown) {
  return error instanceof TraccarApiError ? error.message : "Traccar Server couldn't be updated.";
}

/** Adds an approved phone to Traccar Server, or disables a revoked one there. */
async function syncWithTraccar(link: IDriverTrackingDevice): Promise<void> {
  if (!getTraccarConfig().usable) return;
  try {
    if (link.status === "active") {
      const driver: any = await User.findById(link.driverId).select("name").lean();
      const suffix = link.uniqueId.slice(-4);
      const traccarDeviceId = await addTraccarDevice(link.uniqueId, `Suprah driver ${driver?.name || "unnamed"} (${suffix})`);
      await DriverTrackingDevice.updateOne(
        { _id: link._id, status: "active" },
        { $set: { traccarDeviceId, traccarSyncStatus: "synced", traccarSyncError: null } },
      );
    } else if (link.status === "revoked" && link.traccarDeviceId) {
      await disableTraccarDevice(link.traccarDeviceId);
      await DriverTrackingDevice.updateOne(
        { _id: link._id },
        { $set: { traccarSyncStatus: "synced", traccarSyncError: null } },
      );
    }
  } catch (error) {
    const reason = syncFailure(error);
    await DriverTrackingDevice.updateOne({ _id: link._id }, { $set: { traccarSyncStatus: "failed", traccarSyncError: reason } });
    logger.warn({ linkId: String(link._id), reason }, "Traccar device update failed; will retry");
  }
}

/** Retries Traccar Server updates that failed (run by the catch-up worker). */
export async function retryFailedTraccarDeviceSyncs(): Promise<void> {
  const links = await DriverTrackingDevice.find({
    $or: [
      { status: "active", traccarSyncStatus: { $ne: "synced" } },
      { status: "revoked", traccarDeviceId: { $ne: null }, traccarSyncStatus: "failed" },
    ],
  }).limit(50);
  for (const link of links) await syncWithTraccar(link);
}

async function revokeLink(link: IDriverTrackingDevice, actorId: string, reason: string) {
  const revoked = await DriverTrackingDevice.findOneAndUpdate(
    { _id: link._id, isCurrent: true },
    {
      $set: {
        status: "revoked",
        isCurrent: false,
        revokedBy: actorId,
        revokedAt: new Date(),
        revokeReason: reason,
        ...(link.traccarDeviceId ? { traccarSyncStatus: "not_synced" } : {}),
      },
    },
    { new: true },
  );
  if (revoked?.traccarDeviceId) await syncWithTraccar(revoked);
  return revoked;
}

/** Driver starts setup (a first phone or a replacement). The previous link, if any, is revoked. */
export async function startDeviceLink(driverId: string) {
  if (!getTraccarConfig().usable) throw new ApiError(409, PHONE_TRACKING_UNAVAILABLE);
  const previous = await currentLink(driverId);
  if (previous) await revokeLink(previous, driverId, "replaced_by_driver");
  try {
    return await DriverTrackingDevice.create({ driverId, uniqueId: generateDeviceIdentifier(), status: "pending", isCurrent: true });
  } catch (error: any) {
    // Two setups at once: the other one won.
    if (error?.code === 11000) {
      const winner = await currentLink(driverId);
      if (winner) return winner;
    }
    throw error;
  }
}

/** Driver stops using the linked phone (for example it was lost). */
export async function removeOwnDeviceLink(driverId: string) {
  const link = await currentLink(driverId);
  if (!link) return null;
  return revokeLink(link, driverId, "removed_by_driver");
}

/** A driver reviewer approves the pending link; the phone is then added to Traccar Server. */
export async function approveDeviceLink(driverId: string, approverId: string) {
  if (!getTraccarConfig().usable) throw new ApiError(409, PHONE_TRACKING_UNAVAILABLE);
  const approved = await DriverTrackingDevice.findOneAndUpdate(
    { driverId, isCurrent: true, status: "pending" },
    { $set: { status: "active", approvedBy: approverId, approvedAt: new Date(), traccarSyncStatus: "not_synced" } },
    { new: true },
  );
  if (!approved) {
    const link = await currentLink(driverId);
    if (link?.status === "active") return link;
    throw new ApiError(409, "There's no phone waiting for approval for this driver. Ask them to start phone tracking setup in the Driver Portal.");
  }
  await syncWithTraccar(approved);
  return DriverTrackingDevice.findById(approved._id);
}

/** A driver reviewer removes the link (lost phone, driver leaving, suspected misuse). */
export async function revokeDeviceLinkByStaff(driverId: string, actorId: string) {
  const link = await currentLink(driverId);
  if (!link) throw new ApiError(409, "This driver has no linked phone to remove.");
  return revokeLink(link, actorId, "revoked_by_staff");
}

/** A driver reviewer retries a Traccar Server update that failed. */
export async function retryDeviceLinkSync(driverId: string) {
  const link = await currentLink(driverId);
  if (!link || link.status !== "active") throw new ApiError(409, "This driver has no approved phone to update on Traccar Server.");
  await syncWithTraccar(link);
  return DriverTrackingDevice.findById(link._id);
}

export type PhoneTrackingReminder = "turn_on" | "keep_on" | "not_receiving" | "turn_off" | null;

/** What the Driver Portal should remind the driver about Traccar Client right now. */
export async function phoneTrackingReminder(driverId: string, link: IDriverTrackingDevice | null): Promise<PhoneTrackingReminder> {
  if (!link || link.status !== "active" || !getTraccarConfig().usable) return null;
  const now = Date.now();
  const lastMs = link.lastPositionAt ? new Date(link.lastPositionAt).getTime() : Number.NaN;
  const loads = await getDriverGpsTrackingLoads(driverId);
  if (loads.length) {
    const acceptedMs = Math.min(
      ...loads.map((load) => (load.acceptedAt ? new Date(load.acceptedAt).getTime() : now)),
    );
    if (!Number.isFinite(lastMs) || lastMs < acceptedMs) return "turn_on";
    return now - lastMs > TRACCAR_SILENCE_WARNING_MS ? "not_receiving" : "keep_on";
  }
  return Number.isFinite(lastMs) && now - lastMs < TURN_OFF_REMINDER_WINDOW_MS ? "turn_off" : null;
}

/** The driver's own view: includes the identifier they must enter in Traccar Client. */
export function driverLinkView(link: IDriverTrackingDevice | null) {
  if (!link) return null;
  return {
    status: link.status,
    identifier: link.status === "revoked" ? null : link.uniqueId,
    requestedAt: link.requestedAt,
    approvedAt: link.approvedAt ?? null,
    lastPositionAt: link.lastPositionAt ?? null,
  };
}

/** Reviewers' view: only the identifier's last 4 characters, to match with the driver. */
export async function reviewerLinkView(link: IDriverTrackingDevice | null) {
  if (!link) return null;
  const peopleIds = [link.approvedBy, link.revokedBy].filter(Boolean).map(String);
  const people: any[] = peopleIds.length ? await User.find({ _id: { $in: peopleIds } }).select("_id name").lean() : [];
  const nameOf = (id: unknown) => people.find((person) => String(person._id) === String(id ?? ""))?.name ?? null;
  return {
    status: link.status,
    identifierEndsWith: link.uniqueId.slice(-4),
    requestedAt: link.requestedAt,
    approvedAt: link.approvedAt ?? null,
    approvedByName: nameOf(link.approvedBy),
    lastPositionAt: link.lastPositionAt ?? null,
    traccarSyncStatus: link.traccarSyncStatus,
    traccarSyncError: link.traccarSyncError ?? null,
  };
}

export { currentLink as currentDeviceLink };
