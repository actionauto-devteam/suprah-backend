import mongoose, { Document, Schema } from 'mongoose';

export interface ISyncLog extends Document {
    jobName: string;
    startTime: Date;
    endTime?: Date;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    vehiclesProcessed: number;
    vehiclesAdded: number;
    vehiclesUpdated: number;
    vehiclesDeleted: number;
    errorMessage?: string;
    stackTrace?: string;
}

const SyncLogSchema: Schema = new Schema(
    {
        jobName: { type: String, required: true, default: 'DealersCloud Sync' },
        startTime: { type: Date, required: true, default: Date.now },
        endTime: { type: Date },
        status: {
            type: String,
            enum: ['RUNNING', 'COMPLETED', 'FAILED'],
            default: 'RUNNING',
        },
        vehiclesProcessed: { type: Number, default: 0 },
        vehiclesAdded: { type: Number, default: 0 },
        vehiclesUpdated: { type: Number, default: 0 },
        vehiclesDeleted: { type: Number, default: 0 },
        errorMessage: { type: String },
        stackTrace: { type: String },
    },
    {
        timestamps: true,
    }
);

export default mongoose.model<ISyncLog>('SyncLog', SyncLogSchema);
