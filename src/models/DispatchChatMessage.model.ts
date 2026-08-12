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

dispatchChatMessageSchema.index({
  organizationId: 1,
  driverId: 1,
  createdAt: -1,
});

dispatchChatMessageSchema.index({
  organizationId: 1,
  driverId: 1,
  readBy: 1,
  senderId: 1,
});

const DispatchChatMessage: Model<IDispatchChatMessage> =
  (mongoose.models.DispatchChatMessage as Model<IDispatchChatMessage>) ||
  mongoose.model<IDispatchChatMessage>(
    "DispatchChatMessage",
    dispatchChatMessageSchema,
  );

export default DispatchChatMessage;