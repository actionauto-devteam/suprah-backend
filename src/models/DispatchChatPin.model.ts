import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * A conversation a driver pinned to the top of their Dispatch Chat page: a
 * private dispatcher conversation ("thread") or a group channel. Pins belong
 * to the person only; nobody else sees them.
 */

export const DISPATCH_CHAT_PIN_KINDS = ["thread", "channel"] as const;
export type DispatchChatPinKind = (typeof DISPATCH_CHAT_PIN_KINDS)[number];

export interface IDispatchChatPin extends Document {
  userId: mongoose.Types.ObjectId;
  kind: DispatchChatPinKind;
  targetId: mongoose.Types.ObjectId;
  pinnedAt: Date;
}

const dispatchChatPinSchema = new Schema<IDispatchChatPin>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: DISPATCH_CHAT_PIN_KINDS, required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  pinnedAt: { type: Date, required: true, default: Date.now },
});

dispatchChatPinSchema.index({ userId: 1, kind: 1, targetId: 1 }, { unique: true });

const DispatchChatPin: Model<IDispatchChatPin> =
  (mongoose.models.DispatchChatPin as Model<IDispatchChatPin>) ||
  mongoose.model<IDispatchChatPin>("DispatchChatPin", dispatchChatPinSchema);

export default DispatchChatPin;
