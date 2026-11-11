import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";
import { invalidateUserCache } from "../utils/cache.util";
import User from "../models/User.model";
import Session from "../models/Session.model";
import Load from "../models/Load.model";
import Quote from "../models/Quote.model";
import DriverPayout from "../models/DriverPayout.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import LocationHistory from "../models/LocationHistory.model";
import LoadTripPoint from "../models/LoadTripPoint.model";
import DriverRequest from "../models/DriverRequest.model";
import DriverStatusChangeRequest from "../models/DriverStatusChangeRequest.model";
import Notification from "../models/Notification.model";
import WebAuthnCredential from "../models/WebAuthnCredential.model";
import { SavedVehicle } from "../models/SavedVehicle.model";
import { OwnedVehicle } from "../models/OwnedVehicle.model";
import CustomerShopAiSession from "../models/CustomerShopAiSession.model";
import ShopAssistantChat from "../models/ShopAssistantChat.model";
import MembershipPoints from "../models/MembershipPoints.model";
import PointTransaction from "../models/PointTransaction.model";
import { removeOwnDeviceLink } from "./driverTrackingDevice.service";
import { BucketType, storageService } from "./storage.service";

/*
 * Deleting your own account (decided 2026-11-11). Apple requires apps that let
 * people sign up to let them delete their account in the app.
 *
 * Drivers and customers can delete their own account; staff accounts are
 * removed by their dealership. The account is locked and its personal details
 * are removed straight away: sign-in, name, email, phone, photo, saved
 * signature and notifications, plus a driver's documents, equipment, location
 * history and tracking phone, or a customer's Wishlist, My Garage cars, AI
 * shopping chats and membership points. Business records stay for the
 * dealerships (loads, delivery proofs, payouts, quotes and chats), showing
 * "Former driver" or "Former customer" instead of the name.
 *
 * It's refused, with a plain reason, while a load or a shipment is in
 * progress, or while a driver still has a payout that isn't paid.
 *
 * Before deleting, the person must acknowledge that Suprah AI keeps some
 * transaction records and personal information for compliance, accounting,
 * tax laws and fraud prevention (2026-11-11). The server checks it too, so
 * no app can skip the notice.
 */

export type DeletableRole = "driver" | "customer";

/** A load is in progress from assignment until delivery. */
export const ACTIVE_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"] as const;
/** Payouts still owed to the driver (a failed payment is still owed). */
export const UNPAID_PAYOUT_STATUSES = ["pending", "processing", "failed"] as const;

export const STAFF_DELETION_MESSAGE =
  "Staff accounts can't be deleted here. Ask your dealership admin to remove your account.";

export const RETENTION_ACKNOWLEDGEMENT_REQUIRED =
  "Before your account can be deleted, confirm that you understand Suprah AI keeps some transaction records and personal information for compliance, accounting, tax laws and fraud prevention.";

export const FORMER_NAME: Record<DeletableRole, string> = {
  driver: "Former driver",
  customer: "Former customer",
};

export function deletableRole(role: unknown): DeletableRole | null {
  return role === "driver" || role === "customer" ? role : null;
}

/** What a deleted account keeps: no way to sign in and nothing that identifies the person. */
export function anonymizedAccountUpdate(userId: string, role: DeletableRole) {
  return {
    $set: {
      name: FORMER_NAME[role],
      // Unique and undeliverable, so the old email can sign up again.
      email: `deleted-${userId}@deleted.suprah.invalid`,
      emailVerified: false,
      isActive: false,
      isApproved: false,
      avatar: null,
      pushSubscriptions: [],
    },
    $unset: {
      password: "",
      passwordHash: "",
      otpCode: "",
      otpExpiresAt: "",
      googleId: "",
      passwordResetToken: "",
      passwordResetExpires: "",
      personalInfo: "",
      signatureDataUrl: "",
      signatureUpdatedAt: "",
      stripeConnectAccountId: "",
      referralCode: "",
      locationConsent: "",
      breakStatus: "",
      customStatus: "",
    },
  };
}

export type DeletionFacts = {
  role: DeletableRole;
  /** Load numbers of the driver's loads in progress. */
  activeLoadNumbers?: string[];
  unpaidPayouts?: number;
  /** Cars on the way to the customer. */
  activeShipmentCars?: string[];
};

/** Why the account can't be deleted yet, in plain words, or null when it can. */
export function deletionBlockerMessage(facts: DeletionFacts): string | null {
  if (facts.role === "driver") {
    const loads = facts.activeLoadNumbers ?? [];
    if (loads.length) {
      const which = loads.length === 1 ? `load ${loads[0]}` : `${loads.length} loads (${loads.slice(0, 3).join(", ")})`;
      return `You have ${which} in progress. Deliver it or ask dispatch to take it back, then you can delete your account.`;
    }
    if ((facts.unpaidPayouts ?? 0) > 0) {
      return "You have a payout that hasn't been paid yet. Once it's paid, you can delete your account. Contact the Suprah AI team if you need help.";
    }
    return null;
  }
  const cars = facts.activeShipmentCars ?? [];
  if (cars.length) {
    const which = cars.length === 1 ? `Your ${cars[0]} is` : `${cars.length} vehicles are`;
    return `${which} still being shipped to you. Once it's delivered, you can delete your account.`;
  }
  return null;
}

type AccountUser = { _id: mongoose.Types.ObjectId | string; role?: unknown; email?: unknown };

async function deletionFacts(user: AccountUser, role: DeletableRole): Promise<DeletionFacts> {
  const id = new mongoose.Types.ObjectId(String(user._id));
  if (role === "driver") {
    const [loads, unpaidPayouts] = await Promise.all([
      Load.find({ assignedDriverId: id, status: { $in: ACTIVE_LOAD_STATUSES } })
        .select("loadNumber")
        .limit(5)
        .lean<Array<{ loadNumber?: string }>>(),
      DriverPayout.countDocuments({ driverId: id, status: { $in: UNPAID_PAYOUT_STATUSES } }),
    ]);
    return { role, activeLoadNumbers: loads.map((load) => String(load.loadNumber ?? "")).filter(Boolean), unpaidPayouts };
  }

  // Shipments the customer follows: ones they asked for, or staff quotes with their email.
  const email = String(user.email ?? "").trim().toLowerCase();
  const quotes = await Quote.find({
    $or: [{ requestedBy: id }, ...(email ? [{ email, portalShareOff: { $ne: true } }] : [])],
  })
    .select("_id vehicleName")
    .lean<Array<{ _id: mongoose.Types.ObjectId; vehicleName?: string }>>();
  if (!quotes.length) return { role, activeShipmentCars: [] };
  const active = await Load.find({ quoteId: { $in: quotes.map((quote) => quote._id) }, status: { $in: ACTIVE_LOAD_STATUSES } })
    .select("quoteId")
    .limit(5)
    .lean<Array<{ quoteId?: mongoose.Types.ObjectId }>>();
  const names = new Map(quotes.map((quote) => [String(quote._id), quote.vehicleName || "vehicle"]));
  return { role, activeShipmentCars: active.map((load) => names.get(String(load.quoteId)) ?? "vehicle") };
}

/** The reason this account can't be deleted yet, or null. Staff accounts always get the staff message. */
export async function accountDeletionBlocker(user: AccountUser): Promise<string | null> {
  const role = deletableRole(user.role);
  if (!role) return STAFF_DELETION_MESSAGE;
  return deletionBlockerMessage(await deletionFacts(user, role));
}

/** A stored file's key: the explicit key, or the one in its URL. */
function storedFileKey(file: { fileKey?: unknown; fileUrl?: unknown }): string {
  const key = String(file?.fileKey ?? "").trim();
  if (key) return key;
  const url = String(file?.fileUrl ?? "").trim();
  return url ? storageService.getKeyFromUrl(url) || url : "";
}

/**
 * Deletes the signed-in driver's or customer's own account. Throws a plain
 * ApiError when it can't. `acknowledgedRetention` must be exactly true: the
 * person ticked "I understand what Suprah AI keeps".
 */
export async function deleteOwnAccount(user: AccountUser, options: { acknowledgedRetention?: unknown } = {}): Promise<void> {
  const role = deletableRole(user.role);
  if (!role) throw new ApiError(403, STAFF_DELETION_MESSAGE);
  if (options.acknowledgedRetention !== true) throw new ApiError(400, RETENTION_ACKNOWLEDGEMENT_REQUIRED);
  const blocker = deletionBlockerMessage(await deletionFacts(user, role));
  if (blocker) throw new ApiError(409, blocker);

  const userId = String(user._id);
  const id = new mongoose.Types.ObjectId(userId);
  const before = await User.findById(id).select("avatar").lean<{ avatar?: string | null } | null>();

  // 1. Lock the account and remove what identifies the person, so nothing can use it from here on.
  await User.updateOne({ _id: id }, anonymizedAccountUpdate(userId, role));
  await Session.updateMany({ userId: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  invalidateUserCache(userId);

  // 2. Remove their personal data. Business records stay with the dealerships.
  const privateFiles: string[] = [];
  const publicFiles: string[] = before?.avatar ? [String(before.avatar)] : [];
  const steps: Array<Promise<unknown>> = [
    Notification.deleteMany({ userId: id }),
    WebAuthnCredential.deleteMany({ userId: id }),
  ];

  if (role === "driver") {
    const profile = await DriverProfile.findOne({ userId: id }).select("documents").lean<{ documents?: Array<{ fileKey?: string; fileUrl?: string }> } | null>();
    for (const document of profile?.documents ?? []) {
      const key = storedFileKey(document);
      if (key) privateFiles.push(key);
    }
    const statusRequests = await DriverStatusChangeRequest.find({ driverId: id })
      .select("attachments")
      .lean<Array<{ attachments?: Array<{ fileKey?: string }> }>>();
    for (const request of statusRequests) {
      for (const attachment of request.attachments ?? []) {
        const key = storedFileKey(attachment);
        if (key) privateFiles.push(key);
      }
    }
    steps.push(
      DriverProfile.deleteOne({ userId: id }),
      DriverLocation.deleteMany({ userId: id }),
      LocationHistory.deleteMany({ userId: id }),
      LoadTripPoint.deleteMany({ driverId: id }),
      DriverStatusChangeRequest.deleteMany({ driverId: id }),
      DriverRequest.deleteMany({ driverUserId: id, status: "pending" }),
      // Requests for open loads go, so dispatch can't approve one by mistake.
      Load.updateMany({ "driverRequests.driverId": id }, { $pull: { driverRequests: { driverId: id } } }),
      removeOwnDeviceLink(userId),
    );
  } else {
    steps.push(
      SavedVehicle.deleteMany({ userId: id }),
      OwnedVehicle.deleteMany({ userId: id }),
      CustomerShopAiSession.deleteMany({ customerUserId: id }),
      ShopAssistantChat.deleteMany({ userId }),
      MembershipPoints.deleteMany({ userId: id }),
      PointTransaction.deleteMany({ userId: id }),
    );
  }

  const results = await Promise.allSettled(steps);
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) logger.error({ userId, role, failed }, "Account deletion: some personal data couldn't be removed");

  // 3. Stored files last; a file that can't be removed is logged, not shown.
  await Promise.allSettled([
    ...privateFiles.map((key) => storageService.delete(key, BucketType.PRIVATE)),
    ...publicFiles.map((url) => storageService.delete(url)),
  ]);

  logger.info({ userId, role, retentionNoticeAcknowledged: true }, "Account deleted by its owner");
}
