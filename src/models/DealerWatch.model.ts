import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IDealerWatch extends Document {
    organizationId: string;
    targetOrganizationId: string;
    label?: string;
    createdBy: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

export interface IDealerWatchModel extends Model<IDealerWatch> { }

const DealerWatchSchema = new Schema<IDealerWatch>(
    {
        organizationId: { type: String, required: true, index: true },
        targetOrganizationId: { type: String, required: true },
        label: { type: String, trim: true, maxlength: 80 },
        createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

DealerWatchSchema.index({ organizationId: 1, targetOrganizationId: 1 }, { unique: true });

const DealerWatch = mongoose.model<IDealerWatch, IDealerWatchModel>('DealerWatch', DealerWatchSchema);
export default DealerWatch;
