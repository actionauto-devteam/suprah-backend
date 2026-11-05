import mongoose, { Document, Model, Schema } from "mongoose";

/*
 * The customer's "Confirm received" on a delivered shipment and their one
 * review of it (decided 2026-11-05). One record per load; the review is set
 * once and never edited.
 *
 * Who sees what:
 * - driver stars (1–5): their average is shown to dealerships in Driver
 *   Tracker; the words only to the load's own dealership;
 * - dealership words: only that dealership (and super admins);
 * - the driver sees none of it.
 */
export interface IShipmentReview extends Document {
  organizationId: string;
  loadId: mongoose.Types.ObjectId;
  quoteId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  /** The driver who delivered it, if any (staff can mark a load delivered). */
  driverId?: mongoose.Types.ObjectId | null;
  receivedAt: Date;
  driverStars?: number | null;
  driverComment?: string;
  dealershipComment?: string;
  /** Set once, when the customer sends their review. */
  reviewedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentReviewSchema = new Schema<IShipmentReview>(
  {
    organizationId: { type: String, required: true },
    loadId: { type: Schema.Types.ObjectId, ref: "Load", required: true },
    quoteId: { type: Schema.Types.ObjectId, ref: "Quote", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    receivedAt: { type: Date, required: true },
    driverStars: { type: Number, min: 1, max: 5, default: null },
    driverComment: { type: String, trim: true, maxlength: 1000, default: "" },
    dealershipComment: { type: String, trim: true, maxlength: 2000, default: "" },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One confirmation and one review per load.
shipmentReviewSchema.index({ loadId: 1 }, { unique: true, name: "shipment_review_per_load" });
// A driver's star average (Driver Tracker).
shipmentReviewSchema.index({ driverId: 1, driverStars: 1 });
// A dealership's reviews, newest first.
shipmentReviewSchema.index({ organizationId: 1, reviewedAt: -1 });

const ShipmentReview: Model<IShipmentReview> =
  (mongoose.models.ShipmentReview as Model<IShipmentReview>) ||
  mongoose.model<IShipmentReview>("ShipmentReview", shipmentReviewSchema);

export default ShipmentReview;
