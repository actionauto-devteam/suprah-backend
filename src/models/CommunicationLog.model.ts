import mongoose, { Document, Schema } from "mongoose";

export type CommunicationChannel = "sms" | "email" | "call";
export type CommunicationDirection = "inbound" | "outbound";
export type CommunicationStatus =
  | "logged"
  | "queued"
  | "sent"
  | "delivered"
  | "received"
  | "missed"
  | "failed"
  | "completed";

export interface ICommunicationLog extends Document {
  organizationId: string;
  leadId?: mongoose.Types.ObjectId;
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  status: CommunicationStatus;
  from?: string;
  to?: string;
  body?: string;
  durationSeconds?: number;
  provider?: string;
  providerMessageId?: string;
  metadata?: Record<string, unknown>;
  createdBy?: mongoose.Types.ObjectId;
  createdByModel?: "User" | "CrmUser";
  createdAt: Date;
  updatedAt: Date;
}

const CommunicationLogSchema = new Schema<ICommunicationLog>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    leadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
      index: true,
    },
    channel: {
      type: String,
      enum: ["sms", "email", "call"],
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        "logged",
        "queued",
        "sent",
        "delivered",
        "received",
        "missed",
        "failed",
        "completed",
      ],
      required: true,
      default: "completed",
      index: true,
    },
    from: { type: String, trim: true },
    to: { type: String, trim: true },
    body: { type: String, trim: true, maxlength: 10_000 },
    durationSeconds: { type: Number, min: 0, default: null },
    provider: { type: String, trim: true, default: "internal" },
    providerMessageId: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdBy: {
      type: Schema.Types.ObjectId,
      refPath: "createdByModel",
      default: null,
    },
    createdByModel: {
      type: String,
      enum: ["User", "CrmUser"],
      default: "CrmUser",
    },
  },
  { timestamps: true },
);

CommunicationLogSchema.index({ organizationId: 1, createdAt: -1 });
CommunicationLogSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });

const CommunicationLog = mongoose.model<ICommunicationLog>(
  "CommunicationLog",
  CommunicationLogSchema,
);

export default CommunicationLog;