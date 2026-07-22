import mongoose, { Document, Schema } from 'mongoose';

export type SubscriptionTier =
    | 'suprah_go'
    | 'suprah_premium'
    | 'suprah_premium_pro'
    | 'suprah_premium_ultra'
    | 'suprah_origin';

export interface IOrganizationSubscription {
    tier: SubscriptionTier;
    status: 'active' | 'past_due' | 'cancelled';
    seatLimit: number | null;
    startedAt: Date;
    updatedAt: Date;
    updatedBy?: mongoose.Types.ObjectId;
}

export interface IOrganization extends Document {
    name: string;
    slug: string;
    ownerId: mongoose.Types.ObjectId;
    members?: mongoose.Types.ObjectId[];
    logoUrl?: string;
    metadata?: any;
    status: 'active' | 'suspended' | 'archived';
    subscription: IOrganizationSubscription;
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
    {
        ownerId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: false,
        },
        members: [{
            type: Schema.Types.ObjectId,
            ref: 'User',
        }],
        name: {
            type: String,
            required: true,
            trim: true,
        },
        slug: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        logoUrl: {
            type: String,
        },
        metadata: {
            type: Schema.Types.Mixed,
            default: {},
        },
        status: {
            type: String,
            enum: ['active', 'suspended', 'archived'],
            default: 'active',
        },
        subscription: {
            tier: {
                type: String,
                enum: ['suprah_go', 'suprah_premium', 'suprah_premium_pro', 'suprah_premium_ultra', 'suprah_origin'],
                default: 'suprah_go',
            },
            status: {
                type: String,
                enum: ['active', 'past_due', 'cancelled'],
                default: 'active',
            },
            seatLimit: {
                type: Number,
                default: 5,
            },
            startedAt: {
                type: Date,
                default: Date.now,
            },
            updatedAt: {
                type: Date,
                default: Date.now,
            },
            updatedBy: {
                type: Schema.Types.ObjectId,
                ref: 'User',
            },
        },
    },
    {
        timestamps: true,
    }
);

const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);

export default Organization;
