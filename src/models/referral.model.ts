import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IReferral extends Document {
    referrerId: mongoose.Types.ObjectId; // The native _id of the referer
    referredUserId: mongoose.Types.ObjectId; // The native _id of the new user
    referralCodeUsed: string; // The code that was intercepted (e.g. AAU-JOHN-555)
    createdAt: Date;
    updatedAt: Date;
}

const ReferralSchema = new Schema(
    {
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
