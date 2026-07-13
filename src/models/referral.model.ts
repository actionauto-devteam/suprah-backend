import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IReferral extends Document {
    organizationId: mongoose.Types.ObjectId;
    referrerId: mongoose.Types.ObjectId;
    referredUserId: mongoose.Types.ObjectId;
    referralCodeUsed: string;
    createdAt: Date;
    updatedAt: Date;
}

const ReferralSchema = new Schema(
    {
        organizationId: {
            type: Schema.Types.ObjectId,
            ref: 'Organization',
            required: true,
            index: true,
        },
        referrerId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        referredUserId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true,
        },
        referralCodeUsed: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },
    },
    {
        timestamps: true,
    }
);

const Referral = mongoose.model<IReferral>('Referral', ReferralSchema);

export default Referral;
