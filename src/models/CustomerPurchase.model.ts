import mongoose, { Document, Schema } from 'mongoose';

export const PURCHASE_SOURCES = ['deal', 'lead_sold', 'manual', 'import'] as const;
export type PurchaseSource = (typeof PURCHASE_SOURCES)[number];

export interface PurchaseVehicle {
  vehicleId: mongoose.Types.ObjectId | null;
  label: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  vin: string;
  stock: string;
}

export interface ICustomerPurchase extends Document {
  organizationId: string;
  customerId: mongoose.Types.ObjectId | null;
  leadId: mongoose.Types.ObjectId | null;
  dealId: mongoose.Types.ObjectId | null;
  vehicle: PurchaseVehicle;
  salePrice: number | null;
  soldAt: Date;
  salespersonId: mongoose.Types.ObjectId | null;
  salespersonName: string;
  source: PurchaseSource;
  notes: string;
  importKey: string | null;
  createdBy: { userId: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

const CustomerPurchaseSchema = new Schema<ICustomerPurchase>(
  {
    organizationId: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    dealId: { type: Schema.Types.ObjectId, ref: 'CrmDeal', default: null },
    vehicle: {
      vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
      label: { type: String, default: '', maxlength: 160 },
      year: { type: String, default: '' },
      make: { type: String, default: '' },
      model: { type: String, default: '' },
      trim: { type: String, default: '' },
      vin: { type: String, default: '' },
      stock: { type: String, default: '' },
    },
    salePrice: { type: Number, default: null, min: 0 },
    soldAt: { type: Date, required: true },
    salespersonId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    salespersonName: { type: String, default: '' },
    source: { type: String, enum: PURCHASE_SOURCES, required: true },
    notes: { type: String, default: '', maxlength: 1000 },
    importKey: { type: String, default: null },
    createdBy: {
      userId: { type: String, required: true },
      name: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

CustomerPurchaseSchema.index({ organizationId: 1, customerId: 1, soldAt: -1 });
CustomerPurchaseSchema.index({ organizationId: 1, leadId: 1 });
CustomerPurchaseSchema.index(
  { organizationId: 1, dealId: 1 },
  { unique: true, name: 'customer_purchase_deal', partialFilterExpression: { dealId: { $type: 'objectId' } } },
);
CustomerPurchaseSchema.index(
  { organizationId: 1, importKey: 1 },
  { unique: true, name: 'customer_purchase_import', partialFilterExpression: { importKey: { $type: 'string' } } },
);

const CustomerPurchase = mongoose.model<ICustomerPurchase>('CustomerPurchase', CustomerPurchaseSchema);

export default CustomerPurchase;
