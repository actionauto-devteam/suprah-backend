import mongoose, { Document, Schema } from 'mongoose';

export interface IPayment extends Document {
  organizationId: string;
  customerId: string;

  // Customer info
  customerName: string;
  customerEmail: string;
  customerPhone?: string;

  // Payment details
  amount: number;
  currency: string;
  description: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded' | 'cancelled';

  // Stripe fields
  stripePaymentIntentId?: string;
  stripeCustomerId?: string;
  stripeChargeId?: string;
  paymentMethod?: string;
  receiptUrl?: string;

  // Related entities
  quoteId?: mongoose.Types.ObjectId;
  shipmentId?: mongoose.Types.ObjectId;
  invoiceNumber?: string;

  // Metadata
  failureReason?: string;
  notes?: string;
  paidAt?: Date;
  dueDate?: Date;

  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema: Schema<IPayment> = new Schema(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    customerId: {
      type: String,
      required: true,
      index: true,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    customerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    customerPhone: {
      type: String,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'usd',
      lowercase: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled'],
      default: 'pending',
      index: true,
    },
    stripePaymentIntentId: {
      type: String,
      trim: true,
      sparse: true,
    },
    stripeCustomerId: {
      type: String,
      trim: true,
    },
    stripeChargeId: {
      type: String,
      trim: true,
    },
    paymentMethod: {
      type: String,
      trim: true,
    },
    receiptUrl: {
      type: String,
      trim: true,
    },
    quoteId: {
      type: Schema.Types.ObjectId,
      ref: 'Quote',
    },
    shipmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Shipment',
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    failureReason: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    paidAt: {
      type: Date,
    },
    dueDate: {
      type: Date,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Generate invoice number before save
PaymentSchema.pre('save', async function (next) {
  if (!this.invoiceNumber) {
    const date = new Date();
    const prefix = `INV-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
    const count = await mongoose.model('Payment').countDocuments({
      organizationId: this.organizationId,
    });
    this.invoiceNumber = `${prefix}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

PaymentSchema.set('toJSON', { virtuals: true });
PaymentSchema.set('toObject', { virtuals: true });

const Payment = mongoose.model<IPayment>('Payment', PaymentSchema);

export default Payment;