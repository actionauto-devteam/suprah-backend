import mongoose, { Document, Model, Schema } from "mongoose";

export const LOAD_RELEASE_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type LoadReleaseRequestStatus =
  (typeof LOAD_RELEASE_REQUEST_STATUSES)[number];

export const LOAD_RELEASE_REQUEST_PRIORITIES = ["standard", "emergency"] as const;
export type LoadReleaseRequestPriority =
  (typeof LOAD_RELEASE_REQUEST_PRIORITIES)[number];

export const LOAD_RELEASE_REQUEST_REASONS = [
  "vehicle_issue",
  "personal_emergency",
  "route_issue",
  "load_issue",
  "safety_concern",
  "other",
] as const;
export type LoadReleaseRequestReason =
  (typeof LOAD_RELEASE_REQUEST_REASONS)[number];

export const LOAD_RELEASE_DECISIONS = [
  "keep_assigned",
  "return_available",
  "reassign",
  "delivery_completed",
] as const;
export type LoadReleaseDecision = (typeof LOAD_RELEASE_DECISIONS)[number];

export interface ILoadReleaseRequest extends Document {
  _id: mongoose.Types.ObjectId;
  organizationId: string;
  loadId: mongoose.Types.ObjectId;
  driverId: mongoose.Types.ObjectId;
  dispatcherId?: mongoose.Types.ObjectId;
  priority: LoadReleaseRequestPriority;
  reason: LoadReleaseRequestReason;
  message?: string;
  loadStatusAtRequest: string;
  status: LoadReleaseRequestStatus;
  decision?: LoadReleaseDecision;
  replacementDriverId?: mongoose.Types.ObjectId;
  requestedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  decisionReason?: string;
  /**
   * Durable Load-lifecycle reconciliation metadata. When a Load transition
   * resolves this request through the outbox, the event id makes retries
   * idempotent. Superseded fields preserve a concurrent earlier decision.
   */
  lifecycleResolutionEventId?: string;
  lifecycleResolvedAt?: Date;
  supersededStatus?: LoadReleaseRequestStatus;
  supersededDecision?: LoadReleaseDecision;
  supersededDecisionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const loadReleaseRequestSchema = new Schema<ILoadReleaseRequest>(
  {
    organizationId: { type: String, required: true, index: true },
    loadId: { type: Schema.Types.ObjectId, ref: "Load", required: true, index: true },
    driverId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    dispatcherId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    priority: {
      type: String,
      enum: LOAD_RELEASE_REQUEST_PRIORITIES,
      default: "standard",
      required: true,
    },
    reason: { type: String, enum: LOAD_RELEASE_REQUEST_REASONS, required: true },
    message: { type: String, trim: true, maxlength: 1500 },
    loadStatusAtRequest: { type: String, required: true, maxlength: 40 },
    status: {
      type: String,
      enum: LOAD_RELEASE_REQUEST_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    decision: { type: String, enum: LOAD_RELEASE_DECISIONS },
    replacementDriverId: { type: Schema.Types.ObjectId, ref: "User" },
    requestedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    decisionReason: { type: String, trim: true, maxlength: 1000 },
    // Internal reconciliation metadata. These fields preserve the final Load
    // outcome without erasing evidence of a concurrent request decision.
    lifecycleResolutionEventId: { type: String, trim: true },
    lifecycleResolvedAt: { type: Date },
    supersededStatus: {
      type: String,
      enum: LOAD_RELEASE_REQUEST_STATUSES,
    },
    supersededDecision: {
      type: String,
      enum: LOAD_RELEASE_DECISIONS,
    },
    supersededDecisionReason: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { timestamps: true },
);

// Exactly one unresolved request may exist for a driver/load pair. Rejected or
// completed requests remain as an audit trail and do not block a future request.
loadReleaseRequestSchema.index(
  { loadId: 1, driverId: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);
loadReleaseRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
loadReleaseRequestSchema.index({ dispatcherId: 1, status: 1, createdAt: -1 });
// One durable Load lifecycle event may resolve at most one release-request row.
loadReleaseRequestSchema.index(
  { lifecycleResolutionEventId: 1 },
  { unique: true, sparse: true },
);

const LoadReleaseRequest: Model<ILoadReleaseRequest> =
  (mongoose.models.LoadReleaseRequest as Model<ILoadReleaseRequest>) ||
  mongoose.model<ILoadReleaseRequest>("LoadReleaseRequest", loadReleaseRequestSchema);

export default LoadReleaseRequest;