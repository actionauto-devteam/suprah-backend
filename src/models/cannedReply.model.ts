import mongoose, { Schema, Document } from 'mongoose';

export interface ICannedReply extends Document {
  organizationId: mongoose.Types.ObjectId;
  title: string;
  body: string;
  category?: string;
  createdBy: mongoose.Types.ObjectId;
  isShared: boolean;
  usageCount: number;
  sortOrder?: number;
  createdAt: Date;
  updatedAt: Date;
}

const CannedReplySchema: Schema<ICannedReply> = new Schema<ICannedReply>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    category: {
      type: String,
      trim: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    isShared: {
      type: Boolean,
      default: true,
    },

    usageCount: {
      type: Number,
      default: 0,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

CannedReplySchema.index({ organizationId: 1, isShared: 1, sortOrder: 1 });

export default mongoose.model<ICannedReply>('CannedReply', CannedReplySchema);
