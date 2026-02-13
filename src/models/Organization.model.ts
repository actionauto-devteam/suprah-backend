import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
    clerkId?: string; // Optional now
    name: string;
    slug: string;
    ownerId: mongoose.Types.ObjectId; // Reference to User (ObjectId)
    members?: mongoose.Types.ObjectId[]; // Array of User ObjectIds
    logoUrl?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
    {
        clerkId: {
            type: String,
            sparse: true, // Allows null/undefined to not conflict
        },
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
    },
    {
        timestamps: true,
    }
);

const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);

export default Organization;
