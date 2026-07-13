import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IAftermarketReview extends Document {
  productId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  customerName: string;
  customerAvatar?: string;
  rating: number;
  title?: string;
  body: string;
  isVerifiedPurchase: boolean;
  isVisible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AftermarketReviewSchema = new Schema<IAftermarketReview>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'AftermarketProduct',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    customerName:   { type: String, required: true, trim: true, maxlength: 120 },
    customerAvatar: { type: String, default: null },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    title: { type: String, trim: true, maxlength: 120, default: null },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
    isVerifiedPurchase: { type: Boolean, default: false },
    isVisible:          { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

AftermarketReviewSchema.index({ productId: 1, customerId: 1 }, { unique: true });
AftermarketReviewSchema.index({ productId: 1, isVisible: 1, rating: 1 });

const AftermarketReview: Model<IAftermarketReview> =
  mongoose.models.AftermarketReview ||
  mongoose.model<IAftermarketReview>('AftermarketReview', AftermarketReviewSchema);

export default AftermarketReview;