import mongoose, { Document, Schema } from 'mongoose';

export interface IInvitation extends Document {
    email: string;
    organizationId: mongoose.Types.ObjectId;
    inviterId?: mongoose.Types.ObjectId;
    // 'driver' is deliberately not allowed here — all driver approval goes
    // through the platform-wide DriverRequest queue, never a dealership's
    // own team invitations.
    role: 'admin' | 'member' | 'customer';
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
            required: false,
        },
        role: {
            type: String,
            enum: ['admin', 'member', 'customer'],
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

InvitationSchema.index({ email: 1, status: 1 });

const Invitation = mongoose.model<IInvitation>('Invitation', InvitationSchema);

export default Invitation;
