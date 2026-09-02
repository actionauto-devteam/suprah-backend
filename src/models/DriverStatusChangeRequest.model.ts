import mongoose, { Document, Model, Schema } from "mongoose";

export const DRIVER_STATUS_REQUEST_STATES = [
  "pending",
  "approved_awaiting_reassignment",
  "completed",
  "rejected",
  "cancelled",
] as const;

export type DriverStatusRequestState =
  (typeof DRIVER_STATUS_REQUEST_STATES)[number];

export const DRIVER_STATUS_REQUEST_PRIORITIES = [
  "standard",
  "emergency",
] as const;

export type DriverStatusRequestPriority =
  (typeof DRIVER_STATUS_REQUEST_PRIORITIES)[number];

export const DRIVER_STATUS_REQUEST_REASONS = [
  "personal_leave",
  "scheduled_time_off",
  "vehicle_maintenance",
  "vehicle_breakdown",
  "accident",
  "medical_situation",
  "unsafe_conditions",
  "personal_emergency",
  "other",
] as const;

export type DriverStatusRequestReason =
  (typeof DRIVER_STATUS_REQUEST_REASONS)[number];

export type RequestedDriverOperationalStatus = "on_leave" | "maintenance";

export const DRIVER_STATUS_LOAD_HANDLING_OPTIONS = [
  "keep_assigned",
  "reassign",
  "return_available",
] as const;

export type DriverStatusLoadHandlingDecision =
  (typeof DRIVER_STATUS_LOAD_HANDLING_OPTIONS)[number];

export interface IDriverStatusRequestAttachment {
  _id?: mongoose.Types.ObjectId;
  fileKey: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  uploadedAt: Date;
}

export interface IDriverStatusChangeRequest extends Document {
  _id: mongoose.Types.ObjectId;
  organizationId: string;
  /**
   * Links the per-organization review rows that belong to one global driver
   * Work Availability transition. Legacy single-org requests may omit it.
   */
  transitionGroupId?: string;
  /** Set after the global DriverProfile operationalStatus was applied. */
  globalStatusAppliedAt?: Date;
  driverId: mongoose.Types.ObjectId;
  requestedStatus: RequestedDriverOperationalStatus;
  priority: DriverStatusRequestPriority;
  status: DriverStatusRequestState;
  reason?: DriverStatusRequestReason;
  message?: string;
  effectiveAt?: Date;
  estimatedReturnAt?: Date;
  affectedLoadIds: mongoose.Types.ObjectId[];
  /** Dispatcher decision for loads that were active when the request was reviewed. */
  loadHandlingDecision?: DriverStatusLoadHandlingDecision;
  /** Only meaningful for keep_assigned. Defaults to true in the dispatcher UI. */
  retainedGpsRequired?: boolean;
  loadHandlingResolvedAt?: Date;
  attachments: mongoose.Types.DocumentArray<
    IDriverStatusRequestAttachment & mongoose.Types.Subdocument
  >;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  decisionReason?: string;
  submittedAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<IDriverStatusRequestAttachment>(
  {
    fileKey: { type: String, required: true },
    fileName: { type: String, required: true, maxlength: 255 },
    fileSize: { type: Number, min: 0 },
    mimeType: { type: String, maxlength: 120 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const driverStatusChangeRequestSchema =
  new Schema<IDriverStatusChangeRequest>(
    {
      organizationId: {
        type: String,
        required: true,
        index: true,
      },
      transitionGroupId: {
        type: String,
        index: true,
      },
      globalStatusAppliedAt: { type: Date },
      driverId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
      },
      requestedStatus: {
        type: String,
        enum: ["on_leave", "maintenance"],
        required: true,
      },
      priority: {
        type: String,
        enum: DRIVER_STATUS_REQUEST_PRIORITIES,
        default: "standard",
        required: true,
      },
      status: {
        type: String,
        enum: DRIVER_STATUS_REQUEST_STATES,
        default: "pending",
        required: true,
        index: true,
      },
      reason: {
        type: String,
        enum: DRIVER_STATUS_REQUEST_REASONS,
      },
      message: { type: String, maxlength: 1500 },
      effectiveAt: { type: Date },
      estimatedReturnAt: { type: Date },
      affectedLoadIds: [
        {
          type: Schema.Types.ObjectId,
          ref: "Load",
        },
      ],
      loadHandlingDecision: {
        type: String,
        enum: DRIVER_STATUS_LOAD_HANDLING_OPTIONS,
      },
      retainedGpsRequired: { type: Boolean },
      loadHandlingResolvedAt: { type: Date },
      attachments: { type: [attachmentSchema], default: [] },
      reviewedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
      reviewedAt: { type: Date },
      decisionReason: { type: String, maxlength: 1000 },
      submittedAt: { type: Date, default: Date.now },
      completedAt: { type: Date },
      cancelledAt: { type: Date },
    },
    { timestamps: true },
  );

driverStatusChangeRequestSchema.index({
  organizationId: 1,
  driverId: 1,
  status: 1,
  createdAt: -1,
});

driverStatusChangeRequestSchema.index({
  organizationId: 1,
  priority: 1,
  status: 1,
  createdAt: -1,
});

// Coordinated shared-driver transitions create one row per affected
// organization. This non-unique index keeps group finalization/readback fast
// without breaking legacy rows that do not have a transitionGroupId.
driverStatusChangeRequestSchema.index({
  driverId: 1,
  transitionGroupId: 1,
  createdAt: 1,
});

const DriverStatusChangeRequest: Model<IDriverStatusChangeRequest> =
  mongoose.model<IDriverStatusChangeRequest>(
    "DriverStatusChangeRequest",
    driverStatusChangeRequestSchema,
  );

export default DriverStatusChangeRequest;