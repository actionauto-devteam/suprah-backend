import mongoose, { Document, Model, Schema } from "mongoose";

/*
 * A driver's phone linked to their Suprah account: Traccar Client
 * (provider "traccar") or the Suprah Driver Tracker app (provider "app").
 *
 * The app pairs with a short one-time code the driver gets in the Driver
 * Portal, then authenticates every request with its own random device key.
 * Suprah stores only hashes of the code and the key.
 *
 * Rules (business decisions, 2026-09-30):
 * - The driver starts setup in the Driver Portal; Suprah generates a long
 *   random identifier (the phone's own ids are never used, and an identifier
 *   is never reused). Positions only count once someone who can verify drivers
 *   approves the link.
 * - On approval Suprah adds the device to Traccar Server; on revoke it
 *   disables it there.
 * - One current link per driver: starting setup again (a new or replacement
 *   phone) revokes the previous one.
 * - Traccar Client has no device authentication beyond this identifier, so it
 *   is treated as a secret and never shown to anyone but the driver and
 *   driver reviewers; it is never enough on its own to change a load.
 */

export type DriverTrackingDeviceStatus = "pending" | "active" | "revoked";
export type TraccarSyncStatus = "not_synced" | "synced" | "failed";
export type DriverTrackingDeviceProvider = "traccar" | "app";

export interface IDriverTrackingDevice extends Document {
  driverId: mongoose.Types.ObjectId;
  provider: DriverTrackingDeviceProvider;
  /** Traccar: the identifier entered in Traccar Client. App: its public device id. */
  uniqueId: string;
  status: DriverTrackingDeviceStatus;
  /** true while pending or active: one current link per driver. */
  isCurrent: boolean;
  requestedAt: Date;
  approvedBy?: mongoose.Types.ObjectId | null;
  approvedAt?: Date | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  revokedAt?: Date | null;
  revokeReason?: string | null;
  /** Traccar Server's own device id once Suprah has added the device there. */
  traccarDeviceId?: number | null;
  traccarSyncStatus: TraccarSyncStatus;
  /** Plain-language reason the last Traccar Server update failed. */
  traccarSyncError?: string | null;
  /** Measurement time of the newest position received from this phone. */
  lastPositionAt?: Date | null;
  /** App only: hash of the one-time pairing code, until the app uses it. */
  pairingCodeHash?: string | null;
  pairingCodeExpiresAt?: Date | null;
  /** App only: when the app paired with the code. */
  claimedAt?: Date | null;
  /** App only: hash of the device key the app signs requests with. */
  deviceSecretHash?: string | null;
  /** App only: the phone model and app version it reported when pairing. */
  deviceName?: string | null;
  devicePlatform?: "android" | "ios" | null;
  appVersion?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const driverTrackingDeviceSchema = new Schema<IDriverTrackingDevice>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: String, enum: ["traccar", "app"], default: "traccar" },
    uniqueId: { type: String, required: true, trim: true },
    status: { type: String, enum: ["pending", "active", "revoked"], required: true, default: "pending" },
    isCurrent: { type: Boolean, required: true, default: true },
    requestedAt: { type: Date, required: true, default: Date.now },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null, maxlength: 120 },
    traccarDeviceId: { type: Number, default: null },
    traccarSyncStatus: { type: String, enum: ["not_synced", "synced", "failed"], default: "not_synced" },
    traccarSyncError: { type: String, default: null, maxlength: 300 },
    lastPositionAt: { type: Date, default: null },
    pairingCodeHash: { type: String, default: null, select: false },
    pairingCodeExpiresAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    deviceSecretHash: { type: String, default: null, select: false },
    deviceName: { type: String, default: null, maxlength: 80 },
    devicePlatform: { type: String, enum: ["android", "ios", null], default: null },
    appVersion: { type: String, default: null, maxlength: 40 },
  },
  { timestamps: true },
);

// Identifiers are never reused, even after a link is revoked.
driverTrackingDeviceSchema.index({ uniqueId: 1 }, { unique: true });
// At most one pending/active link per driver.
driverTrackingDeviceSchema.index(
  { driverId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);
driverTrackingDeviceSchema.index({ status: 1, traccarSyncStatus: 1 });
// The app pairs by its code (only unused codes are stored).
driverTrackingDeviceSchema.index({ pairingCodeHash: 1 }, { sparse: true });

const DriverTrackingDevice: Model<IDriverTrackingDevice> =
  (mongoose.models.DriverTrackingDevice as Model<IDriverTrackingDevice>) ||
  mongoose.model<IDriverTrackingDevice>("DriverTrackingDevice", driverTrackingDeviceSchema);

export default DriverTrackingDevice;
