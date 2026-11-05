import mongoose, { Document, Model, Schema } from "mongoose";

/** A photo sent in a shipment chat, kept in private storage. */
export interface IShipmentChatPhoto {
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;
}

/** One message in a customer's shipment chat (see ShipmentChatThread). */
export interface IShipmentChatMessage extends Document {
  organizationId: string;
  threadId: mongoose.Types.ObjectId;
  loadId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  senderRole: "customer" | "driver" | "dispatcher";
  content: string;
  photos: IShipmentChatPhoto[];
  readBy: mongoose.Types.ObjectId[];
  /** Set by the sender's app, so a retried send isn't posted twice. */
  clientMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentChatPhotoSchema = new Schema<IShipmentChatPhoto>(
  {
    fileKey: { type: String, required: true },
    originalName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, maxlength: 80 },
    size: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const shipmentChatMessageSchema = new Schema<IShipmentChatMessage>(
  {
    organizationId: { type: String, required: true },
    threadId: { type: Schema.Types.ObjectId, ref: "ShipmentChatThread", required: true },
    loadId: { type: Schema.Types.ObjectId, ref: "Load", required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    senderRole: { type: String, enum: ["customer", "driver", "dispatcher"], required: true },
    content: { type: String, trim: true, maxlength: 4000, default: "" },
    photos: { type: [shipmentChatPhotoSchema], default: [] },
    readBy: { type: [Schema.Types.ObjectId], ref: "User", default: [] },
    clientMessageId: { type: String, trim: true, maxlength: 100 },
  },
  { timestamps: true },
);

// A thread's messages, newest first (history paging).
shipmentChatMessageSchema.index({ threadId: 1, createdAt: -1 });
// Unread counts: messages in these threads not yet read by the viewer.
shipmentChatMessageSchema.index({ threadId: 1, readBy: 1 });
// One message per sender per clientMessageId (a retry returns the first).
shipmentChatMessageSchema.index(
  { senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } },
);

const ShipmentChatMessage: Model<IShipmentChatMessage> =
  (mongoose.models.ShipmentChatMessage as Model<IShipmentChatMessage>) ||
  mongoose.model<IShipmentChatMessage>("ShipmentChatMessage", shipmentChatMessageSchema);

export default ShipmentChatMessage;
