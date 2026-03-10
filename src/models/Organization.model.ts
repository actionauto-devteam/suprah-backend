import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
    name: string;
    slug: string;
    ownerId: mongoose.Types.ObjectId; // Reference to User (ObjectId)
    members?: mongoose.Types.ObjectId[]; // Array of User ObjectIds
    logoUrl?: string;
    metadata?: any;
    status: 'active' | 'suspended' | 'archived';
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
    {
        ownerId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: false, // Optional during migration
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
    },
    {
        timestamps: true,
    }
);

const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);

export default Organization;
