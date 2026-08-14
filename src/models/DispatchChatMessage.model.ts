import mongoose, { Document, Model, Schema } from "mongoose";

export interface IDispatchChatAttachment {
  url: string;
  fileKey?: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface IDispatchChatMessage extends Document {
  organizationId: string;
  // New private-thread fields are optional at schema level so existing legacy
  // shared-driver records remain readable in MongoDB. Every NEW message written
  // by the private-chat controller includes both fields.
  threadId?: mongoose.Types.ObjectId;
  dispatcherId?: mongoose.Types.ObjectId;
  driverId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  senderRole: "driver" | "dispatcher";
  messageType: "message" | "system";
  systemEvent?: {
    type?: string;
    title?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  } | null;
  content: string;
  attachments: IDispatchChatAttachment[];
  readBy: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const dispatchChatAttachmentSchema = new Schema<IDispatchChatAttachment>(
  {
    url: { type: String, required: true },
    fileKey: { type: String },
    originalName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, maxlength: 160 },
    size: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const dispatchChatMessageSchema = new Schema<IDispatchChatMessage>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    threadId: {
      type: Schema.Types.ObjectId,
      ref: "DispatchChatThread",
      index: true,
    },
    dispatcherId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    senderRole: {
      type: String,
      enum: ["driver", "dispatcher"],
      required: true,
    },
    messageType: {
      type: String,
      enum: ["message", "system"],
      default: "message",
      index: true,
    },
    systemEvent: {
      type: Schema.Types.Mixed,
      default: null,
    },
    content: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: "",
    },
    attachments: {
      type: [dispatchChatAttachmentSchema],
      default: [],
    },
    readBy: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
  },
  { timestamps: true },
);

// Private-thread indexes. Legacy records without threadId/dispatcherId remain
// untouched and are intentionally excluded from new private unread/history
// queries unless their ownership can be established safely.
dispatchChatMessageSchema.index({
  organizationId: 1,
  threadId: 1,
  createdAt: -1,
});

dispatchChatMessageSchema.index({
  organizationId: 1,
  dispatcherId: 1,
  driverId: 1,
  createdAt: -1,
});

dispatchChatMessageSchema.index({
  organizationId: 1,
  dispatcherId: 1,
  readBy: 1,
  senderId: 1,
});

dispatchChatMessageSchema.index({
  organizationId: 1,
  driverId: 1,
  readBy: 1,
  senderId: 1,
});

// Keep the old index shape as a migration-friendly lookup for explicit legacy
// dispatcher-authored messages. New private queries do not use it as the sole
// privacy boundary.
dispatchChatMessageSchema.index({
  organizationId: 1,
  driverId: 1,
  createdAt: -1,
});

const DispatchChatMessage: Model<IDispatchChatMessage> =
  (mongoose.models.DispatchChatMessage as Model<IDispatchChatMessage>) ||
  mongoose.model<IDispatchChatMessage>(
    "DispatchChatMessage",
    dispatchChatMessageSchema,
  );

export default DispatchChatMessage;