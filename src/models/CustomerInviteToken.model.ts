import mongoose, { Document, Schema } from 'mongoose';

export interface ICustomerInviteToken extends Document {
  shortCode: string;
  organizationId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId; // CrmUser who generated the link
  expiresAt: Date;
  isUsed: boolean;
  multiUse: boolean; // if true, link can be used by multiple users until it expires
  usedAt?: Date;
  usedBy?: mongoose.Types.ObjectId; // User who registered via this link
  createdAt: Date;
}

const CustomerInviteTokenSchema = new Schema<ICustomerInviteToken>(
  {
    shortCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
    isUsed: {
      type: Boolean,
      default: false,
    },
    multiUse: {
      type: Boolean,
      default: false,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    usedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model<ICustomerInviteToken>(
  'CustomerInviteToken',
  CustomerInviteTokenSchema
);
