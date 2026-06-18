import mongoose, { Document, Schema } from 'mongoose';

// ─── Line item ────────────────────────────────────────────────────────────────
// A single billable row on an invoice. `kind` lets the UI group/colour rows and
// lets the totals helper know how to treat the amount (discounts subtract).
export interface IPaymentLineItem {
  label: string;
  kind: 'product' | 'fee' | 'charge' | 'discount';
  quantity: number;
  unitPrice: number;   // per-unit, in major currency units (e.g. dollars)
  lineTotal: number;   // quantity * unitPrice (negative for discounts)
}

export interface IPayment extends Document {
  organizationId: string;
  orgId?: mongoose.Types.ObjectId;
  customerId: string;

  customerName: string;
  customerEmail: string;
  customerPhone?: string;

  // Money. `amount` is the grand total that Stripe charges.
  amount: number;
  subtotal?: number;
  taxRate?: number;     // percentage, e.g. 8.25
  taxAmount?: number;
  lineItems?: IPaymentLineItem[];

  currency: string;
  description: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded' | 'cancelled';

  // Where this invoice originated. Aftermarket invoices link back to product/inquiry.
  source?: 'manual' | 'aftermarket';
  aftermarketProductId?: mongoose.Types.ObjectId;
  inquiryId?: mongoose.Types.ObjectId;

  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  stripeCustomerId?: string;
  stripeChargeId?: string;
  paymentMethod?: string;
  receiptUrl?: string;

  quoteId?: mongoose.Types.ObjectId;
  shipmentId?: mongoose.Types.ObjectId;
  loadId?: mongoose.Types.ObjectId;
  invoiceNumber?: string;

  failureReason?: string;
  notes?: string;
  paidAt?: Date;
  dueDate?: Date;

  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// Separate counter collection for atomic invoice numbering
const InvoiceCounterSchema = new Schema({
  _id: { type: String, required: true },   // organizationId + year-month key
  seq: { type: Number, default: 0 },
});
const InvoiceCounter = mongoose.models.InvoiceCounter || mongoose.model('InvoiceCounter', InvoiceCounterSchema);

const LineItemSchema = new Schema<IPaymentLineItem>(
  {
    label: { type: String, required: true, trim: true },
    kind: {
      type: String,
      enum: ['product', 'fee', 'charge', 'discount'],
      default: 'product',
    },
    quantity: { type: Number, required: true, min: 0, default: 1 },
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
  },
  { _id: false }
);

const PaymentSchema: Schema<IPayment> = new Schema(
  {
    organizationId: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    customerId: { type: String, required: true, index: true },
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, trim: true },

    amount: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, min: 0 },
    taxRate: { type: Number, min: 0, default: 0 },
    taxAmount: { type: Number, min: 0, default: 0 },
    lineItems: { type: [LineItemSchema], default: undefined },

    currency: { type: String, default: 'usd', lowercase: true },
    description: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled'],
      default: 'pending',
      index: true,
    },

    source: { type: String, enum: ['manual', 'aftermarket'], default: 'manual', index: true },
    aftermarketProductId: { type: Schema.Types.ObjectId, ref: 'AftermarketProduct', index: true },
    inquiryId: { type: Schema.Types.ObjectId, ref: 'AftermarketInquiry', index: true },

    stripePaymentIntentId: { type: String, trim: true, sparse: true, unique: true },
    stripeCheckoutSessionId: { type: String, trim: true, sparse: true, index: true },
    stripeCustomerId: { type: String, trim: true },
    stripeChargeId: { type: String, trim: true },
    paymentMethod: { type: String, trim: true },
    receiptUrl: { type: String, trim: true },

    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote' },
    shipmentId: { type: Schema.Types.ObjectId, ref: 'Shipment' },
    loadId: { type: Schema.Types.ObjectId, ref: 'Load' },
    invoiceNumber: { type: String, trim: true, index: true },

    failureReason: { type: String, trim: true },
    notes: { type: String, trim: true },
    paidAt: { type: Date },
    dueDate: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Compound index for common org-level queries
PaymentSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
// Customer-portal lookups by email
PaymentSchema.index({ customerEmail: 1, status: 1, createdAt: -1 });
// Text index for server-side search
PaymentSchema.index({
  customerName: 'text',
  customerEmail: 'text',
  invoiceNumber: 'text',
  description: 'text',
});

// Atomic invoice numbering using findOneAndUpdate + $inc
PaymentSchema.pre('save', async function (next) {
  if (this.invoiceNumber) return next();

  const date = new Date();
  const yearMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  const counterId = `${this.organizationId}:${yearMonth}`;

  const counter = await InvoiceCounter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );

  this.invoiceNumber = `INV-${yearMonth}-${String(counter.seq).padStart(4, '0')}`;
  next();
});

PaymentSchema.set('toJSON', { virtuals: true });
PaymentSchema.set('toObject', { virtuals: true });

const Payment = mongoose.model<IPayment>('Payment', PaymentSchema);
export default Payment;