import mongoose, { Document, Schema } from 'mongoose';

export type DealershipInquiryStatus = 'pending' | 'invited' | 'registered' | 'dismissed';

export interface IDealershipInquiry extends Document {
  email: string;
  status: DealershipInquiryStatus;
  invitedAt?: Date;
  invitedBy?: mongoose.Types.ObjectId;
  inviteTokenId?: mongoose.Types.ObjectId;
  registeredOrganizationId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DealershipInquirySchema = new Schema<IDealershipInquiry>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'invited', 'registered', 'dismissed'],
      default: 'pending',
    },
    invitedAt: {
      type: Date,
    },
    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    inviteTokenId: {
      type: Schema.Types.ObjectId,
      ref: 'CustomerInviteToken',
    },
    registeredOrganizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
    },
  },
  { timestamps: true }
);

DealershipInquirySchema.index({ email: 1 });
DealershipInquirySchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IDealershipInquiry>('DealershipInquiry', DealershipInquirySchema);
