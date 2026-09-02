import mongoose, { Document, Model, Schema } from "mongoose";

export interface IDispatchChatThread extends Document {
  organizationId: string;
  dispatcherId: mongoose.Types.ObjectId;
  driverId: mongoose.Types.ObjectId;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string;
  lastMessageSenderId?: mongoose.Types.ObjectId | null;
  lastMessageType?: "message" | "system" | null;
  createdAt: Date;
  updatedAt: Date;
}

const dispatchChatThreadSchema = new Schema<IDispatchChatThread>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    dispatcherId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    lastMessageAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastMessagePreview: {
      type: String,
      default: "",
      maxlength: 280,
    },
    lastMessageSenderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastMessageType: {
      type: String,
      enum: ["message", "system"],
      default: null,
    },
  },
  { timestamps: true },
);

// A dispatcher and driver can have exactly one private conversation inside
// an organization. The number of distinct dispatcher/driver combinations is
// not limited; this only prevents duplicate threads for the same exact pair.
dispatchChatThreadSchema.index(
  { organizationId: 1, dispatcherId: 1, driverId: 1 },
  { unique: true },
);

dispatchChatThreadSchema.index({
  organizationId: 1,
  driverId: 1,
  lastMessageAt: -1,
});

// Drivers can participate in exact private threads owned by different
// dispatcher organizations because Driver Tracker uses a shared driver pool.
// This index supports the driver's "all of my private dispatcher threads"
// query without weakening the unique organization+dispatcher+driver boundary.
dispatchChatThreadSchema.index({
  driverId: 1,
  lastMessageAt: -1,
});

dispatchChatThreadSchema.index({
  organizationId: 1,
  dispatcherId: 1,
  lastMessageAt: -1,
});

const DispatchChatThread: Model<IDispatchChatThread> =
  (mongoose.models.DispatchChatThread as Model<IDispatchChatThread>) ||
  mongoose.model<IDispatchChatThread>(
    "DispatchChatThread",
    dispatchChatThreadSchema,
  );

export default DispatchChatThread;