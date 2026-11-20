import mongoose, { Document, Schema } from 'mongoose';

/**
 * A payout from Suprah to a dealership (2026-11-21, decision A4): Suprah keeps
 * every customer payment and sends each dealership what it is owed, weekly,
 * after a super admin approves it.
 *
 * `allocations` say how much of each customer payment this payout covers
 * (negative for a refund or lost dispute after an earlier payout). A payout
 * counts as sent from the moment it is recorded as "sending", before Stripe is
 * asked, so the same money can never be sent twice, even if the server stops
 * mid-way. Only a payout Stripe refused ("failed") stops counting.
 */
export type DealershipPayoutStatus = 'sending' | 'sent' | 'failed';

export interface IDealershipPayoutAllocation {
  paymentId: mongoose.Types.ObjectId;
  amount: number;
}

export interface IDealershipPayout extends Document {
  organizationId: string;
  organizationName: string;
  /** Payments paid before this moment (Monday 00:00, Utah time) are included. */
  cutoff: Date;
  /** Sent to the dealership, in dollars. */
  amount: number;
  /** What the customer payments kept (after refunds and lost disputes). */
  paymentsTotal: number;
  /** Suprah's fee on them. */
  suprahFee: number;
  /** Refunds and lost disputes on payments an earlier payout covered (zero or less). */
  adjustments: number;
  paymentCount: number;
  allocations: IDealershipPayoutAllocation[];
  status: DealershipPayoutStatus;
  stripeAccountId: string;
  stripeTransferId?: string;
  failureReason?: string;
  approvedBy: mongoose.Types.ObjectId;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AllocationSchema = new Schema<IDealershipPayoutAllocation>(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

const DealershipPayoutSchema = new Schema<IDealershipPayout>(
  {
    organizationId: { type: String, required: true },
    organizationName: { type: String, trim: true, default: '' },
    cutoff: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    paymentsTotal: { type: Number, required: true },
    suprahFee: { type: Number, required: true, min: 0 },
    adjustments: { type: Number, default: 0 },
    paymentCount: { type: Number, required: true, min: 0 },
    allocations: { type: [AllocationSchema], default: [] },
    status: { type: String, enum: ['sending', 'sent', 'failed'], required: true, index: true },
    stripeAccountId: { type: String, required: true },
    stripeTransferId: { type: String },
    failureReason: { type: String, trim: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

// A dealership's payout history, newest first; and what each payout covered.
DealershipPayoutSchema.index({ organizationId: 1, createdAt: -1 });
DealershipPayoutSchema.index({ status: 1, 'allocations.paymentId': 1 });

const DealershipPayout =
  (mongoose.models.DealershipPayout as mongoose.Model<IDealershipPayout>) ||
  mongoose.model<IDealershipPayout>('DealershipPayout', DealershipPayoutSchema);

export default DealershipPayout;
