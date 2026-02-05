import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
    clerkId: string;
    name: string;
    slug: string;
    logoUrl?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema: Schema<IOrganization> = new Schema(
    {
        clerkId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
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
