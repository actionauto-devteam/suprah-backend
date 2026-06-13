import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IAftermarketAttachment {
  url: string;        // public R2 URL (or /uploads/ local fallback)
  key?: string;       // R2 key, useful for deletion
  fileName?: string;  // original filename for display
  mimeType?: string;
  size?: number;      // bytes
}

export interface IAftermarketProduct extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  price?: number;
  description: string;
  /** Optional document attachment (brochure, spec sheet, PDF, etc.) */
  file?: IAftermarketAttachment;
  /** Optional photo OR video attachment */
  media?: IAftermarketAttachment & { mediaType?: 'image' | 'video' };
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId; // CrmUser who created it
  createdAt: Date;
  updatedAt: Date;
}

const AttachmentSchema = new Schema<IAftermarketAttachment>(
  {
    url: { type: String, required: true },
    key: { type: String },
    fileName: { type: String },
    mimeType: { type: String },
    size: { type: Number },
  },
  { _id: false }
);

const AftermarketProductSchema = new Schema<IAftermarketProduct>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    price: {
      type: Number,
      required: false,
      min: 0,
      default: undefined,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    file: {
      type: AttachmentSchema,
      required: false,
      default: undefined,
    },
    media: {
      type: new Schema(
        {
          url: { type: String, required: true },
          key: { type: String },
          fileName: { type: String },
          mimeType: { type: String },
          size: { type: Number },
          mediaType: { type: String, enum: ['image', 'video'] },
        },
        { _id: false }
      ),
      required: false,
      default: undefined,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
  },
  { timestamps: true }
);

// Common query: products for an org, sorted newest first, filtered by active
AftermarketProductSchema.index({ organizationId: 1, isActive: 1, createdAt: -1 });

const AftermarketProduct: Model<IAftermarketProduct> =
  mongoose.models.AftermarketProduct ||
  mongoose.model<IAftermarketProduct>('AftermarketProduct', AftermarketProductSchema);

export default AftermarketProduct;