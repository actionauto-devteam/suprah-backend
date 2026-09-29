import mongoose, { Document, Model, Schema } from "mongoose";

/** A photo or file stored privately; members get a short-lived link. */
export interface IDispatchChannelAttachment {
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface IDispatchChannelMessage extends Document {
  _id: mongoose.Types.ObjectId;
  channelId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  senderKind: "driver" | "staff";
  /** "system" rows record membership and channel changes. */
  messageType: "message" | "system";
  /** Can be empty when the message only has photos or files. */
  content: string;
  attachments: IDispatchChannelAttachment[];
  systemEvent?: { type: string; metadata?: Record<string, any> } | null;
  /** Retry key from the sender's device, so a resent message is stored once. */
  clientMessageId?: string;
  /** Set when the sender changed the text. */
  editedAt?: Date | null;
  /** A deleted message keeps its place in the history with no text or files. */
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const dispatchChannelAttachmentSchema = new Schema<IDispatchChannelAttachment>(
  {
    fileKey: { type: String, required: true },
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const dispatchChannelMessageSchema = new Schema<IDispatchChannelMessage>(
  {
    channelId: { type: Schema.Types.ObjectId, ref: "DispatchChannel", required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    senderKind: { type: String, enum: ["driver", "staff"], required: true },
    messageType: { type: String, enum: ["message", "system"], required: true, default: "message" },
    content: { type: String, trim: true, maxlength: 4000, default: "" },
    attachments: { type: [dispatchChannelAttachmentSchema], default: [] },
    systemEvent: {
      type: new Schema(
        { type: { type: String, required: true }, metadata: { type: Schema.Types.Mixed } },
        { _id: false },
      ),
      default: null,
    },
    clientMessageId: { type: String, trim: true, maxlength: 100 },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// Newest first, with a tie-breaker for messages sent in the same instant.
dispatchChannelMessageSchema.index({ channelId: 1, createdAt: -1, _id: -1 });
dispatchChannelMessageSchema.index(
  { senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } },
);

const DispatchChannelMessage: Model<IDispatchChannelMessage> =
  (mongoose.models.DispatchChannelMessage as Model<IDispatchChannelMessage>) ||
  mongoose.model<IDispatchChannelMessage>("DispatchChannelMessage", dispatchChannelMessageSchema);

export default DispatchChannelMessage;
