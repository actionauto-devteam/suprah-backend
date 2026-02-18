import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
    entityType: 'Vehicle' | 'SyncJob' | 'Organization' | 'User' | 'Lead' | 'Quote' | 'Conversation' | 'System' | 'Billing' | 'Shipment' | 'Driver' | 'Invitation';
    entityId?: mongoose.Types.ObjectId | string;
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'SYNC_STATUS' | 'LOGIN' | 'LOGOUT' | 'PAYMENT_FAILED' | 'PAYMENT_SUCCESS';
    changes?: any;
    reason: string;
    performedBy?: mongoose.Types.ObjectId;
    timestamp: Date;
}

const AuditLogSchema: Schema = new Schema(
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
                'Driver',
                'Invitation'
            ]
        },
        entityId: { type: Schema.Types.Mixed },
        action: { type: String, required: true, enum: ['CREATE', 'UPDATE', 'DELETE', 'SYNC_STATUS', 'LOGIN', 'LOGOUT', 'PAYMENT_FAILED', 'PAYMENT_SUCCESS'] },
        changes: { type: Schema.Types.Mixed },
        reason: { type: String, required: true },
        performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        timestamp: { type: Date, default: Date.now },
    },
    {
        timestamps: true,
    }
);

export default mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
