import mongoose, { Document, Schema } from "mongoose";

export interface IPlaceVisit extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  placeId: mongoose.Types.ObjectId;
  placeName: string;
  enteredAt: Date;
  exitedAt?: Date;
  durationMin?: number;
  method: "auto" | "manual_checkin";
  createdAt: Date;
  updatedAt: Date;
}

const PlaceVisitSchema = new Schema<IPlaceVisit>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userName: { type: String, required: true },
    placeId: {
      type: Schema.Types.ObjectId,
      ref: "Place",
      required: true,
    },
    placeName: { type: String, required: true },
    enteredAt: { type: Date, required: true, default: Date.now },
    exitedAt: { type: Date },
    durationMin: { type: Number },
    method: {
      type: String,
      enum: ["auto", "manual_checkin"],
      default: "auto",
    },
  },
  {
    timestamps: true,
  },
);

PlaceVisitSchema.index({ organizationId: 1, userId: 1, enteredAt: -1 });
PlaceVisitSchema.index({ organizationId: 1, placeId: 1, enteredAt: -1 });

const PlaceVisit = mongoose.model<IPlaceVisit>("PlaceVisit", PlaceVisitSchema);

export default PlaceVisit;
