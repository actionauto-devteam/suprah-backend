import mongoose, { Document, Schema } from 'mongoose';

export interface ISession extends Document {
    userId: mongoose.Types.ObjectId;
    refreshTokenHash: string;
    deviceHeader?: string;
    ip?: string;
    expiresAt: Date;
    /**
     * Set the first time this refresh token is used (rotated).
     * While `Date.now() - rotatedAt` is within the reuse grace window,
     * concurrent reuse (multi-tab race) is treated as benign and fresh
     * tokens are issued. Outside the window, reuse is treated as theft
     * and all of the user's sessions are revoked.
     */
    rotatedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const SessionSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        refreshTokenHash: {
            type: String,
            required: true,
            unique: true,
        },
        deviceHeader: {
            type: String,
        },
        ip: {
            type: String,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 },
        },
        rotatedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
    }
);

SessionSchema.index({ userId: 1, expiresAt: 1 });

const Session = mongoose.model<ISession>('Session', SessionSchema);

export default Session;