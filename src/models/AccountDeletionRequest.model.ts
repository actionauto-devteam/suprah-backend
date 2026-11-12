import mongoose, { Document, Schema } from 'mongoose';

/*
 * A staff member's request to delete their account (2026-11-12). An admin of
 * their dealership approves it (the account is erased like a driver's or
 * customer's) or rejects it with a reason the staff member sees. Only the
 * account's id is kept here, never their name or email.
 */

export const DELETION_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type DeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];

export interface IAccountDeletionRequest extends Document {
    userId: mongoose.Types.ObjectId;
    organizationId: mongoose.Types.ObjectId;
    status: DeletionRequestStatus;
    /** Optional words from the staff member to their admin; cleared once decided. */
    note?: string;
    /** They ticked that Suprah AI keeps some records (see accountDeletion.service). */
    acknowledgedRetention: boolean;
    decidedBy?: mongoose.Types.ObjectId;
    decidedAt?: Date;
    rejectionReason?: string;
    createdAt: Date;
    updatedAt: Date;
}

const AccountDeletionRequestSchema = new Schema<IAccountDeletionRequest>(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
        status: { type: String, enum: DELETION_REQUEST_STATUSES, default: 'pending', required: true },
        note: { type: String, trim: true, maxlength: 500 },
        acknowledgedRetention: { type: Boolean, required: true },
        decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        decidedAt: { type: Date },
        rejectionReason: { type: String, trim: true, maxlength: 500 },
    },
    { timestamps: true },
);

AccountDeletionRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
AccountDeletionRequestSchema.index({ userId: 1, createdAt: -1 });
// At most one open request per account.
AccountDeletionRequestSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });

export default mongoose.models.AccountDeletionRequest ||
    mongoose.model<IAccountDeletionRequest>('AccountDeletionRequest', AccountDeletionRequestSchema);
