import crypto from "crypto";
import { getTraccarConfig } from "../config/traccar";
import { PAIRING_CODE_TTL_MS, getTrackingAppConfig } from "../config/trackingApp";
import DriverTrackingDevice, {
  DriverTrackingDeviceProvider,
  IDriverTrackingDevice,
} from "../models/DriverTrackingDevice.model";
import User from "../models/User.model";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";
import { getDriverGpsTrackingLoads } from "./driverLocationAccess.service";
import { TraccarApiError, addTraccarDevice, disableTraccarDevice } from "./traccar.service";

/*
 * Linking a driver's phone to their account: Traccar Client, or the Suprah
 * Driver Tracker app. See models/DriverTrackingDevice.model.ts for the rules.
 */

/** Suprah hasn't received a phone position for this long during an active load: warn the driver. */
export const TRACCAR_SILENCE_WARNING_MS = 5 * 60_000;
/** A phone still reporting this recently with no active load gets "you can turn it off". */
const TURN_OFF_REMINDER_WINDOW_MS = 2 * 60 * 60_000;

export const PHONE_TRACKING_UNAVAILABLE =
  "Phone tracking isn't available yet. Your company is still setting it up; your location keeps being shared from the Driver Portal.";

/**
 * Which phone tracking new setups use: the company's own app when it's
 * switched on, otherwise Traccar when it's configured, otherwise none.
 */
export function phoneTrackingProvider(): DriverTrackingDeviceProvider | null {
  if (getTrackingAppConfig().enabled) return "app";
  if (getTraccarConfig().usable) return "traccar";
  return null;
}

function providerAvailable(provider: DriverTrackingDeviceProvider): boolean {
  return provider === "app" ? getTrackingAppConfig().enabled : getTraccarConfig().usable;
}

/** 96 random bits, letters and digits only (Traccar Client's identifier field). */
export function generateDeviceIdentifier(): string {
  return `SPR${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

// Pairing codes: 8 characters without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Codes are compared without the dash, spaces or letter case. */
export function normalizePairingCode(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function currentLink(driverId: string) {
  return DriverTrackingDevice.findOne({ driverId, isCurrent: true });
}

function syncFailure(error: unknown) {
  return error instanceof TraccarApiError ? error.message : "Traccar Server couldn't be updated.";
}

/** Adds an approved phone to Traccar Server, or disables a revoked one there. */
async function syncWithTraccar(link: IDriverTrackingDevice): Promise<void> {
  if (link.provider === "app" || !getTraccarConfig().usable) return;
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
    provider: { $ne: "app" },
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
        // A revoked app can never use its code or key again.
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
        deviceSecretHash: null,
        ...(link.traccarDeviceId ? { traccarSyncStatus: "not_synced" } : {}),
      },
    },
    { new: true },
  );
  if (revoked?.traccarDeviceId) await syncWithTraccar(revoked);
  return revoked;
}

/**
 * Driver starts setup (a first phone or a replacement). The previous link, if
 * any, is revoked. For the app, the plain pairing code is returned once here
 * (only its hash is stored).
 */
export async function startDeviceLink(driverId: string): Promise<{ link: IDriverTrackingDevice; pairingCode: string | null }> {
  const provider = phoneTrackingProvider();
  if (!provider) throw new ApiError(409, PHONE_TRACKING_UNAVAILABLE);
  const previous = await currentLink(driverId);
  if (previous) await revokeLink(previous, driverId, "replaced_by_driver");
  const pairingCode = provider === "app" ? generatePairingCode() : null;
  try {
    const link = await DriverTrackingDevice.create({
      driverId,
      provider,
      uniqueId: generateDeviceIdentifier(),
      status: "pending",
      isCurrent: true,
      ...(pairingCode
        ? {
            pairingCodeHash: sha256(normalizePairingCode(pairingCode)),
            pairingCodeExpiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
          }
        : {}),
    });
    return { link, pairingCode };
  } catch (error: any) {
    // Two setups at once: the other one won.
    if (error?.code === 11000) {
      const winner = await currentLink(driverId);
      if (winner) return { link: winner, pairingCode: null };
    }
    throw error;
  }
}

/** Driver asks for a fresh pairing code (the old one expired or was lost) before the app has paired. */
export async function renewPairingCode(driverId: string): Promise<{ link: IDriverTrackingDevice; pairingCode: string }> {
  if (!getTrackingAppConfig().enabled) throw new ApiError(409, PHONE_TRACKING_UNAVAILABLE);
  const link = await currentLink(driverId);
  if (!link || link.provider !== "app") {
    throw new ApiError(409, "Start phone tracking setup first, then get a pairing code.");
  }
  if (link.claimedAt) {
    throw new ApiError(409, "Your phone is already paired. To use a different phone, set up a new phone instead.");
  }
  const pairingCode = generatePairingCode();
  const updated = await DriverTrackingDevice.findOneAndUpdate(
    { _id: link._id, isCurrent: true, claimedAt: null },
    {
      $set: {
        pairingCodeHash: sha256(normalizePairingCode(pairingCode)),
        pairingCodeExpiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
      },
    },
    { new: true },
  );
  if (!updated) throw new ApiError(409, "Your phone was just paired. Refresh the page.");
  return { link: updated, pairingCode };
}

const PAIRING_REFUSED =
  "That pairing code isn't valid. Check it in the Driver Portal under Settings → Phone tracking, or get a new code.";

/**
 * The app pairs with the driver's code. Returns the device id and a new
 * random device key, shown only this once; the code can't be used again.
 */
export async function pairTrackingApp(input: {
  code: unknown;
  deviceName?: unknown;
  platform?: unknown;
  appVersion?: unknown;
}) {
  if (!getTrackingAppConfig().enabled) throw new ApiError(409, PHONE_TRACKING_UNAVAILABLE);
  const code = normalizePairingCode(input.code);
  if (code.length !== 8) throw new ApiError(400, PAIRING_REFUSED);

  const deviceSecret = crypto.randomBytes(32).toString("base64url");
  const platform = input.platform === "ios" ? "ios" : input.platform === "android" ? "android" : null;
  const text = (value: unknown, max: number) => {
    const clean = String(value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
    return clean || null;
  };

  const link = await DriverTrackingDevice.findOneAndUpdate(
    {
      provider: "app",
      isCurrent: true,
      claimedAt: null,
      pairingCodeHash: sha256(code),
      pairingCodeExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        claimedAt: new Date(),
        deviceSecretHash: sha256(deviceSecret),
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
        deviceName: text(input.deviceName, 80),
        devicePlatform: platform,
        appVersion: text(input.appVersion, 40),
      },
    },
    { new: true },
  );
  if (!link) throw new ApiError(404, PAIRING_REFUSED);

  const driver: any = await User.findById(link.driverId).select("name").lean();
  return { link, deviceSecret, driverName: String(driver?.name ?? "").trim() || "Driver" };
}

export type TrackingAppAuthFailure = "missing" | "unknown" | "unlinked";

/**
 * Checks an app request's device id and key. The key is compared by hash in
 * constant time. A revoked or replaced app is told it was unlinked.
 */
export async function authenticateTrackingApp(
  deviceId: string,
  deviceSecret: string,
): Promise<{ link: IDriverTrackingDevice } | { failure: TrackingAppAuthFailure }> {
  if (!deviceId || !deviceSecret || deviceId.length > 64 || deviceSecret.length > 128) return { failure: "missing" };
  const link = await DriverTrackingDevice.findOne({ uniqueId: deviceId, provider: "app" }).select("+deviceSecretHash");
  if (!link) return { failure: "unknown" };
  if (link.status === "revoked" || !link.isCurrent) return { failure: "unlinked" };
  const stored = Buffer.from(String(link.deviceSecretHash ?? ""), "hex");
  const given = Buffer.from(sha256(deviceSecret), "hex");
  if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) return { failure: "unknown" };
  return { link };
}

/** Driver stops using the linked phone (for example it was lost). */
export async function removeOwnDeviceLink(driverId: string) {
  const link = await currentLink(driverId);
  if (!link) return null;
  return revokeLink(link, driverId, "removed_by_driver");
}

/** The app itself unlinks (the driver tapped "Unlink this phone" in the app). */
export async function removeTrackingAppLink(link: IDriverTrackingDevice) {
  return revokeLink(link, String(link.driverId), "removed_from_app");
}

/** A driver reviewer approves the pending link; a Traccar phone is then added to Traccar Server. */
export async function approveDeviceLink(driverId: string, approverId: string) {
  const pending = await currentLink(driverId);
  if (pending && !providerAvailable(pending.provider)) throw new ApiError(409, PHONE_TRACKING_UNAVAILABLE);
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
  if (!link || link.status !== "active" || link.provider === "app") {
    throw new ApiError(409, "This driver has no approved Traccar phone to update on Traccar Server.");
  }
  await syncWithTraccar(link);
  return DriverTrackingDevice.findById(link._id);
}

/** Records the newest measurement received from a phone (never moves backwards). */
export async function notePhonePosition(linkId: unknown, measuredAt: Date) {
  await DriverTrackingDevice.updateOne(
    { _id: linkId, $or: [{ lastPositionAt: null }, { lastPositionAt: { $lt: measuredAt } }] },
    { $set: { lastPositionAt: measuredAt } },
  );
}

export type PhoneTrackingReminder = "turn_on" | "keep_on" | "not_receiving" | "turn_off" | null;

/** What the Driver Portal should remind the driver about their tracking phone right now. */
export async function phoneTrackingReminder(driverId: string, link: IDriverTrackingDevice | null): Promise<PhoneTrackingReminder> {
  if (!link || link.status !== "active" || !providerAvailable(link.provider)) return null;
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

/** The driver's own view. Traccar: includes the identifier they enter in Traccar Client. */
export function driverLinkView(link: IDriverTrackingDevice | null) {
  if (!link) return null;
  const isApp = link.provider === "app";
  return {
    provider: link.provider ?? "traccar",
    status: link.status,
    identifier: isApp || link.status === "revoked" ? null : link.uniqueId,
    requestedAt: link.requestedAt,
    approvedAt: link.approvedAt ?? null,
    lastPositionAt: link.lastPositionAt ?? null,
    paired: isApp ? Boolean(link.claimedAt) : null,
    pairingCodeExpiresAt: isApp && !link.claimedAt ? link.pairingCodeExpiresAt ?? null : null,
    deviceName: isApp ? link.deviceName ?? null : null,
  };
}

/** Reviewers' view: only the identifier's last 4 characters, to match with the driver. */
export async function reviewerLinkView(link: IDriverTrackingDevice | null) {
  if (!link) return null;
  const peopleIds = [link.approvedBy, link.revokedBy].filter(Boolean).map(String);
  const people: any[] = peopleIds.length ? await User.find({ _id: { $in: peopleIds } }).select("_id name").lean() : [];
  const nameOf = (id: unknown) => people.find((person) => String(person._id) === String(id ?? ""))?.name ?? null;
  const isApp = link.provider === "app";
  return {
    provider: link.provider ?? "traccar",
    status: link.status,
    identifierEndsWith: link.uniqueId.slice(-4),
    requestedAt: link.requestedAt,
    approvedAt: link.approvedAt ?? null,
    approvedByName: nameOf(link.approvedBy),
    lastPositionAt: link.lastPositionAt ?? null,
    paired: isApp ? Boolean(link.claimedAt) : null,
    deviceName: isApp ? link.deviceName ?? null : null,
    appVersion: isApp ? link.appVersion ?? null : null,
    traccarSyncStatus: isApp ? null : link.traccarSyncStatus,
    traccarSyncError: isApp ? null : link.traccarSyncError ?? null,
  };
}

export { currentLink as currentDeviceLink };
