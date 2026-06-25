import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IDealershipReview extends Document {
  organizationId: mongoose.Types.ObjectId;
  source: 'google' | 'yelp' | 'facebook' | 'other';
  reviewerName: string;
  rating: number;
  reviewText: string;
  reviewUrl?: string;
  reviewDate?: Date;
  response?: string;
  isVisible: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DealershipReviewSchema = new Schema<IDealershipReview>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['google', 'yelp', 'facebook', 'other'],
      default: 'other',
    },
    reviewerName: { type: String, required: true, trim: true, maxlength: 120 },
    rating: { type: Number, required: true, min: 1, max: 5 },
    reviewText: { type: String, required: true, trim: true, maxlength: 2000 },
    reviewUrl: { type: String, trim: true, default: null },
    reviewDate: { type: Date, default: null },
    response: { type: String, trim: true, maxlength: 2000, default: null },
    isVisible: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

DealershipReviewSchema.index({ organizationId: 1, createdAt: -1 });
DealershipReviewSchema.index({ organizationId: 1, isVisible: 1, rating: 1 });

const DealershipReview: Model<IDealershipReview> =
  mongoose.models.DealershipReview ||
  mongoose.model<IDealershipReview>('DealershipReview', DealershipReviewSchema);

export default DealershipReview;
