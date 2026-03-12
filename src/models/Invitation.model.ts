import mongoose, { Document, Schema } from 'mongoose';

export interface IInvitation extends Document {
    email: string;
    organizationId: mongoose.Types.ObjectId; // Stored as ObjectId
    inviterId?: mongoose.Types.ObjectId;
    role: 'admin' | 'member';
    token: string;
    expiresAt: Date;
    status: 'pending' | 'accepted' | 'expired';
    createdAt: Date;
    updatedAt: Date;
}

const InvitationSchema = new Schema<IInvitation>(
    {
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
        },
        organizationId: {
            type: Schema.Types.ObjectId,
            ref: 'Organization',
            required: true,
        },
        inviterId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: false, // Optional to support legacy invites
        },
        role: {
            type: String,
            enum: ['admin', 'member', 'customer', 'driver'],
            default: 'member',
        },
        token: {
            type: String,
            required: true,
            unique: true,
        },
        expiresAt: {
            type: Date,
            required: true,
        },
        status: {
            type: String,
            enum: ['pending', 'accepted', 'expired'],
            default: 'pending',
        },
    },
    {
        timestamps: true,
    }
);

// Index for finding pending invites for an email
InvitationSchema.index({ email: 1, status: 1 });

const Invitation = mongoose.model<IInvitation>('Invitation', InvitationSchema);

export default Invitation;
