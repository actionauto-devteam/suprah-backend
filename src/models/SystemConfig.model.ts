import mongoose, { Document, Schema } from 'mongoose';

export interface ISystemConfig extends Document {
    key: string;
    value: Schema.Types.Mixed;
    description?: string;
    updatedAt: Date;
    createdAt: Date;
}

const SystemConfigSchema = new Schema<ISystemConfig>(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        value: {
            type: Schema.Types.Mixed,
            required: true,
        },
        description: {
            type: String,
        },
    },
    {
        timestamps: true,
    }
);

const SystemConfig = mongoose.model<ISystemConfig>('SystemConfig', SystemConfigSchema);

export default SystemConfig;
