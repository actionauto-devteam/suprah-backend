import mongoose, { Document, Schema } from 'mongoose';

export type PriceDropEmailStatus = 'sent' | 'skipped' | 'failed';
export type PriceDropMatchMethod = 'vin' | 'stock' | 'fuzzy';

export interface IPriceDropEmailLog extends Document {
  organizationId: string;
  vehicleId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  vehicleLabel: string;
  leadEmail: string;
  previousPrice: number;
  newPrice: number;
  priceChangedAt: Date;
  matchMethod: PriceDropMatchMethod;
  status: PriceDropEmailStatus;
  skippedReason?: string;
  failureReason?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PriceDropEmailLogSchema: Schema<IPriceDropEmailLog> = new Schema(
  {
    organizationId: { type: String, required: true },
    vehicleId: { type: Schema.Types.ObjectId, required: true, ref: 'Vehicle' },
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead' },
    vehicleLabel: { type: String, required: true, trim: true },
    leadEmail: { type: String, required: true, trim: true, lowercase: true },
    previousPrice: { type: Number, required: true },
    newPrice: { type: Number, required: true },
    priceChangedAt: { type: Date, required: true },
    matchMethod: { type: String, enum: ['vin', 'stock', 'fuzzy'], required: true },
    status: {
      type: String,
      enum: ['sent', 'skipped', 'failed'],
      required: true,
      index: true,
    },
    skippedReason: { type: String, trim: true, maxlength: 500 },
    failureReason: { type: String, trim: true, maxlength: 500 },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

PriceDropEmailLogSchema.index({ leadId: 1, vehicleId: 1, priceChangedAt: 1 }, { unique: true });
PriceDropEmailLogSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const PriceDropEmailLog = mongoose.model<IPriceDropEmailLog>('PriceDropEmailLog', PriceDropEmailLogSchema);

export default PriceDropEmailLog;
