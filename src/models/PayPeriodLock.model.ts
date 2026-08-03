import mongoose, { Document, Schema } from 'mongoose';

/**
 * One record per user per bi-monthly pay period (1st–15th / 16th–EOM).
 * Presence of a record with status 'paid' or 'auto-locked' means TimeLog
 * corrections for dates inside [periodStart, periodEnd] must be rejected —
 * see the lock check in correctTimeLog. No record (or status 'unlocked')
 * means the period is still editable.
 *
 * - 'paid': an admin explicitly marked this user as paid for this period
 *   (Payroll Status page) — locks immediately, regardless of payday date.
 * - 'auto-locked': nobody marked it manually, but the period's payday has
 *   already passed — the stale-shift-style backend safety net, so a period
 *   can never be left editable forever just because no one remembered to
 *   click "Mark as Paid".
 * - 'unlocked': an admin used the emergency override to temporarily reopen
 *   an already-locked period for a genuine correction. Stays unlocked until
 *   an admin re-locks it (Mark as Paid again) — it is NOT re-auto-locked on
 *   the next scheduler tick, since that would fight the very thing the
 *   override exists for.
 */
export interface IPayPeriodLock extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  periodStart: Date;
  periodEnd: Date;
  status: 'paid' | 'auto-locked' | 'unlocked';
  lockedAt: Date;
  lockedBy: mongoose.Types.ObjectId | null;
  lockedByName: string | null;
  unlockedAt?: Date | null;
  unlockedBy?: mongoose.Types.ObjectId | null;
  unlockedByName?: string | null;
  unlockReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PayPeriodLockSchema = new Schema<IPayPeriodLock>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: { type: String, enum: ['paid', 'auto-locked', 'unlocked'], required: true, index: true },
    lockedAt: { type: Date, required: true },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    lockedByName: { type: String, default: null },
    unlockedAt: { type: Date, default: null },
    unlockedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    unlockedByName: { type: String, default: null },
    unlockReason: { type: String, default: null },
  },
  { timestamps: true }
);

PayPeriodLockSchema.index({ userId: 1, periodStart: 1, periodEnd: 1 }, { unique: true });

export const PayPeriodLock: mongoose.Model<IPayPeriodLock> =
  mongoose.models.PayPeriodLock || mongoose.model<IPayPeriodLock>('PayPeriodLock', PayPeriodLockSchema);
