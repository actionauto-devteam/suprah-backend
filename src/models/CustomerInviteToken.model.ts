import mongoose, { Document, Schema } from 'mongoose';

export type InviteAccountType = 'customer' | 'driver' | 'dealership';

export interface ICustomerInviteToken extends Document {
  shortCode: string;
  // Unset for driver/dealership invites — drivers are a shared pool, and a
  // dealership invite has no Organization to point at yet (that's what
  // completing registration creates).
  organizationId?: mongoose.Types.ObjectId;
  // Set for org-admin-generated (customer) invites.
  createdBy?: mongoose.Types.ObjectId;
  // Set for super_admin-generated (driver/dealership) invites.
  createdByUser?: mongoose.Types.ObjectId;
  // Only set for dealership invites — binds the link to one specific email,
  // unlike customer/driver links which stay shareable.
  email?: string;
  expiresAt: Date;
  isUsed: boolean;
  multiUse: boolean;
  accountType: InviteAccountType;
  usedAt?: Date;
  usedBy?: mongoose.Types.ObjectId;
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
      required: false,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: false,
    },
    createdByUser: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: false,
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
    // Which kind of account this invite creates. Existing tokens without the
    // field fall back to 'customer', so old links keep working unchanged.
    accountType: {
      type: String,
      enum: ['customer', 'driver', 'dealership'],
      default: 'customer',
      index: true,
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