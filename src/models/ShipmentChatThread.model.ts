import mongoose, { Document, Model, Schema } from "mongoose";

/*
 * One private chat between the customer who follows a shipment and the
 * load's current driver ("driver") or dispatcher ("dispatcher"). See
 * services/shipmentChatAccess.ts for the rules.
 *
 * A thread belongs to exactly one customer and one staff member or driver.
 * When the load changes hands, the old thread is retired (active: false) and
 * the new person starts a new, empty one, so nobody reads a conversation they
 * weren't part of.
 */
export interface IShipmentChatThread extends Document {
  organizationId: string;
  loadId: mongoose.Types.ObjectId;
  quoteId: mongoose.Types.ObjectId;
  kind: "driver" | "dispatcher";
  customerId: mongoose.Types.ObjectId;
  /** The driver (kind "driver") or the dispatcher (kind "dispatcher"). */
  staffId: mongoose.Types.ObjectId;
  /** False once the load changed hands; the thread is then never shown again. */
  active: boolean;
  retiredAt?: Date | null;
  /** Set when the dispatcher closes their chat (they can reopen it). */
  closedAt?: Date | null;
  closedBy?: mongoose.Types.ObjectId | null;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string;
  lastMessageSenderId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentChatThreadSchema = new Schema<IShipmentChatThread>(
  {
    organizationId: { type: String, required: true, index: true },
    loadId: { type: Schema.Types.ObjectId, ref: "Load", required: true },
    quoteId: { type: Schema.Types.ObjectId, ref: "Quote", required: true },
    kind: { type: String, enum: ["driver", "dispatcher"], required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    staffId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    active: { type: Boolean, default: true },
    retiredAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: "", maxlength: 280 },
    lastMessageSenderId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// One live chat of each kind per load. Retired threads keep their history
// for the record but no longer count.
shipmentChatThreadSchema.index(
  { loadId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: "shipment_chat_active_per_load" },
);

// My Shipments: the customer's live chats on their loads.
shipmentChatThreadSchema.index({ customerId: 1, loadId: 1, active: 1 });

// Dispatch Chat's Customers section: a driver's or dispatcher's live chats, newest first.
shipmentChatThreadSchema.index({ staffId: 1, kind: 1, active: 1, lastMessageAt: -1 });

const ShipmentChatThread: Model<IShipmentChatThread> =
  (mongoose.models.ShipmentChatThread as Model<IShipmentChatThread>) ||
  mongoose.model<IShipmentChatThread>("ShipmentChatThread", shipmentChatThreadSchema);

export default ShipmentChatThread;
