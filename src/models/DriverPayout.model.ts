import mongoose, { Document, Schema } from 'mongoose';

export interface IDriverPayout extends Document {
  organizationId: string;
  loadId: mongoose.Types.ObjectId;
  driverId: mongoose.Types.ObjectId;
  driverName: string;
  driverEmail: string;
  amount: number;
  currency: string;
  description: string;
  status: 'pending' | 'processing' | 'paid' | 'failed';
  stripeTransferId?: string;
  payoutNumber?: string;
  paidAt?: Date;
  failureReason?: string;
  notes?: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DriverPayoutSchema: Schema<IDriverPayout> = new Schema(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    loadId: {
      type: Schema.Types.ObjectId,
      ref: 'Load',
      required: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    driverName: {
      type: String,
      required: true,
      trim: true,
    },
    driverEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
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
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'failed'],
      default: 'pending',
      index: true,
    },
    stripeTransferId: {
      type: String,
      trim: true,
      sparse: true,
    },
    payoutNumber: {
      type: String,
      trim: true,
    },
    paidAt: {
      type: Date,
    },
    failureReason: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
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

// Auto-generate payout number before save
DriverPayoutSchema.pre('save', async function (next) {
  if (!this.payoutNumber) {
    const date = new Date();
    const prefix = `PAY-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
    const count = await mongoose.model('DriverPayout').countDocuments({
      organizationId: this.organizationId,
    });
    this.payoutNumber = `${prefix}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

DriverPayoutSchema.set('toJSON', { virtuals: true });
DriverPayoutSchema.set('toObject', { virtuals: true });

const DriverPayout = mongoose.model<IDriverPayout>('DriverPayout', DriverPayoutSchema);

export default DriverPayout;
