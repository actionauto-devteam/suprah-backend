import mongoose, { Document, Schema } from 'mongoose';

export type MarketingContactConsentStatus = 'unknown' | 'claimed_verbal' | 'documented';

export interface IMarketingContact extends Document {
  organizationId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  source: string;
  consentStatus: MarketingContactConsentStatus;
  consentNote?: string;
  importLabel: string;
  importedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const MarketingContactSchema: Schema<IMarketingContact> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    firstName: { type: String, trim: true, maxlength: 120 },
    lastName: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 40 },
    source: { type: String, required: true, trim: true, maxlength: 120 },
    consentStatus: {
      type: String,
      enum: ['unknown', 'claimed_verbal', 'documented'],
      required: true,
      default: 'unknown',
    },
    consentNote: { type: String, trim: true, maxlength: 1000 },
    importLabel: { type: String, required: true, trim: true, maxlength: 120, index: true },
    importedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

MarketingContactSchema.index({ organizationId: 1, email: 1 }, { unique: true });
MarketingContactSchema.index({ organizationId: 1, importLabel: 1 });
MarketingContactSchema.index({ organizationId: 1, createdAt: -1 });

const MarketingContact = mongoose.model<IMarketingContact>('MarketingContact', MarketingContactSchema);

export default MarketingContact;
