import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IReferral extends Document {
    referrerClerkId: string; // The Clerk ID of the user who shared the link
    referredUserClerkId: string; // The Clerk ID of the new user who signed up
    referralCodeUsed: string; // The code that was intercepted (e.g. AAU-JOHN-555)
    createdAt: Date;
    updatedAt: Date;
}

const ReferralSchema = new Schema(
    {
        referrerClerkId: {
            type: String,
            required: true,
            index: true,
        },
        referredUserClerkId: {
            type: String,
            required: true,
            unique: true, // A user can only be referred ONCE
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
