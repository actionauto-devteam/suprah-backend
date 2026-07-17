import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
    entityType: 'Vehicle' | 'SyncJob' | 'Organization' | 'User' | 'Lead' | 'Quote' | 'Conversation' | 'System' | 'Billing' | 'Shipment' | 'Load' | 'Driver' | 'Invitation' | 'Referral' | 'Transaction' | 'TimeLog' | 'Screenshot';
    entityId?: mongoose.Types.ObjectId | string;
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'SYNC_STATUS' | 'LOGIN' | 'LOGOUT' | 'PAYMENT_FAILED' | 'PAYMENT_SUCCESS' | 'APPROVE_REWARD' | 'APPROVE_WITHDRAWAL' | 'REJECT_WITHDRAWAL' | 'CORRECT_TIME_LOG' | 'EXCLUDE_SCREENSHOT' | 'ADMIN_DELETE_SCREENSHOT';
    changes?: any;
    reason: string;
    performedBy?: mongoose.Types.ObjectId;
    timestamp: Date;
    organizationId?: string;
}

const InternalAuditLogSchema: Schema = new Schema(
    {
        entityType: {
            type: String,
            required: true,
            enum: [
                'Vehicle',
                'SyncJob',
                'Organization',
                'User',
                'Lead',
                'Quote',
                'Conversation',
                'System',
                'Billing',
                'Shipment',
                'Load',
                'Driver',
                'Invitation',
                'Referral',
                'Transaction',
                'TimeLog',
                'Screenshot'
            ]
        },
        entityId: { type: Schema.Types.Mixed },
        action: { type: String, required: true, enum: ['CREATE', 'UPDATE', 'DELETE', 'SYNC_STATUS', 'LOGIN', 'LOGOUT', 'PAYMENT_FAILED', 'PAYMENT_SUCCESS', 'APPROVE_REWARD', 'APPROVE_WITHDRAWAL', 'REJECT_WITHDRAWAL', 'CORRECT_TIME_LOG', 'EXCLUDE_SCREENSHOT', 'ADMIN_DELETE_SCREENSHOT'] },
        changes: { type: Schema.Types.Mixed },
        reason: { type: String, required: true },
        performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        timestamp: {
            type: Date,
            default: Date.now,
            index: { name: 'ttl_30_days', expireAfterSeconds: 30 * 24 * 60 * 60 }
        },
        organizationId: { type: String, index: true },
    },
    {
        timestamps: true,
    }
);

export default mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', InternalAuditLogSchema);
