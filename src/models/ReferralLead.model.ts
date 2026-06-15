import mongoose, { Document, Schema } from 'mongoose';

export type ReferralLeadStatus = 'pending' | 'contacted' | 'converted' | 'closed';
export type CallRequestType = 'voice' | 'video';

export interface IReferralLead extends Document {
  name: string;
  phone: string;
  email: string;
  requestType: CallRequestType;
  referralCode: string;
  referrerId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  status: ReferralLeadStatus;
  notes?: string;
  convertedUserId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ReferralLeadSchema = new Schema<IReferralLead>(
  {
    name:         { type: String, required: true, trim: true },
    phone:        { type: String, required: true, trim: true },
    email:        { type: String, required: true, trim: true, lowercase: true },
    requestType:  { type: String, enum: ['voice', 'video'], required: true },
    referralCode: { type: String, required: true, trim: true, uppercase: true, index: true },
    referrerId:   { type: Schema.Types.ObjectId, ref: 'User',         required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    status: {
      type:    String,
      enum:    ['pending', 'contacted', 'converted', 'closed'],
      default: 'pending',
      index:   true,
    },
    notes:           { type: String },
    convertedUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

const ReferralLead = mongoose.model<IReferralLead>('ReferralLead', ReferralLeadSchema);
export default ReferralLead;
