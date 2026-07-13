import mongoose, { Document, Schema } from 'mongoose';

export interface ISession extends Document {
    userId: mongoose.Types.ObjectId;
    refreshTokenHash: string;
    deviceHeader?: string;
    ip?: string;
    expiresAt: Date;
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
    },
    {
        timestamps: true,
    }
);

SessionSchema.index({ userId: 1, expiresAt: 1 });

const Session = mongoose.model<ISession>('Session', SessionSchema);

export default Session;
