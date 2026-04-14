import mongoose, { Schema, Document } from 'mongoose';

export interface IOrgLeadConfig extends Document {
    organizationId: mongoose.Types.ObjectId;
    connectedBy: mongoose.Types.ObjectId;

    // Gmail OAuth Configuration
    gmailAddress: string;
    accessToken: string;  // AES-256-GCM encrypted
    refreshToken: string; // AES-256-GCM encrypted
    expiryDate: number;
    gmailConnected: boolean;
    calendarConnected: boolean;

    // Configuration for lead source filtering
    leadSourceEmail: string; // e.g., 'leads@dealerscloud.com'

    // ADF Webhook Security
    webhookSecret: string; // AES-256-GCM encrypted HMAC secret

    // Runtime / Status
    isActive: boolean;
    lastSyncAt?: Date;
    connectedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const OrgLeadConfigSchema: Schema = new Schema({
    organizationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Organization',
        required: true,
        unique: true
    },
    connectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    gmailAddress: { type: String, required: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiryDate: { type: Number, required: true },
    gmailConnected: { type: Boolean, default: false },
    calendarConnected: { type: Boolean, default: false },
    leadSourceEmail: { type: String, default: 'leads@dealerscloud.com' },
    webhookSecret: { type: String },
    isActive: { type: Boolean, default: true, index: true },
    lastSyncAt: { type: Date },
    connectedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// OrganizationId unique index is already defined in the field definition above

export default mongoose.model<IOrgLeadConfig>('OrgLeadConfig', OrgLeadConfigSchema);
