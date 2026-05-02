import mongoose, { Document, Schema } from 'mongoose';

export interface ITransaction extends Document {
    organizationId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    type: 'deposit' | 'withdrawal' | 'adjustment';
    status: 'pending' | 'completed' | 'rejected';
    amount: number;
    note: string;

    // Withdrawal-specific fields
    withdrawalMethod?: {
        type: 'venmo' | 'paypal' | 'bank_transfer' | 'check';
        details: string; // The handle, routing number, etc.
    };

    referralId?: mongoose.Types.ObjectId; // Link back to the generating referral if applicable
    quoteId?: mongoose.Types.ObjectId;
    loadId?: mongoose.Types.ObjectId;
    paymentId?: mongoose.Types.ObjectId; // Link to the specific payment that triggered this
    createdAt: Date;
    updatedAt: Date;
}

const TransactionSchema = new Schema(
    {
        organizationId: {
            type: Schema.Types.ObjectId,
            ref: 'Organization',
            required: true,
            index: true,
        },
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        type: {
            type: String,
            enum: ['deposit', 'withdrawal', 'adjustment'],
            required: true,
        },
        status: {
            type: String,
            enum: ['pending', 'completed', 'rejected'],
            required: true,
            default: 'pending',
        },
        amount: {
            type: Number,
            required: true,
        },
        note: {
            type: String,
            required: true,
            trim: true,
        },
        withdrawalMethod: {
            type: {
                type: String,
                enum: ['venmo', 'paypal', 'bank_transfer', 'check'],
            },
            details: {
                type: String,
            },
        },
        referralId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Referral',
        },
        quoteId: { type: Schema.Types.ObjectId, ref: 'Quote' },
        loadId: { type: Schema.Types.ObjectId, ref: 'Load' },
        paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    },
    {
        timestamps: true,
    }
);

const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);

export default Transaction;
