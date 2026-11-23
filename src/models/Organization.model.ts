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
    /** SuprahPay for this dealership (2026-11-21); see services/suprahPaySettings. */
    suprahPay?: {
        /** Set by a super admin. Unset means on only for Suprah Origin dealerships (the pilot). */
        enabled?: boolean;
        /** Default sales tax rate in percent, set by the dealership's admins. */
        defaultTaxRate?: number;
        /** The dealership's Stripe payout account (Stripe Connect), for Suprah's weekly payouts. */
        stripeAccountId?: string;
        /** Payouts cover customer payments paid from this moment (when the payout account was connected). */
        payoutsStartAt?: Date;
        /** Set while a payout is being sent, so only one is sent at a time. */
        payoutClaimedAt?: Date | null;
        updatedAt?: Date;
        updatedBy?: mongoose.Types.ObjectId;
    };
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
        // The payout account, the payout lock and who last changed the settings
        // stay on the server (2026-11-23): left out unless a query names them
        // (or the whole suprahPay), so the dealership record sent to members
        // and customers never includes them.
        suprahPay: {
            enabled: { type: Boolean },
            defaultTaxRate: { type: Number, min: 0, max: 100 },
            stripeAccountId: { type: String, trim: true, select: false },
            payoutsStartAt: { type: Date },
            payoutClaimedAt: { type: Date, select: false },
            updatedAt: { type: Date },
            updatedBy: { type: Schema.Types.ObjectId, ref: 'User', select: false },
        },
    },
    {
        timestamps: true,
    }
);

const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);

export default Organization;
