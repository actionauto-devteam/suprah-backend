import mongoose, { Document, Schema } from 'mongoose';

export interface IServiceRecord {
    vehicleId: mongoose.Types.ObjectId;
    serviceType: 'OIL_CHANGE' | 'TIRES' | 'BRAKES' | 'INSPECTION' | 'OTHER';
    date: Date;
    mileageAtService: number;
    locationName: string;
    cost?: number;
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}

const ServiceRecordSchema: Schema = new Schema(
    {
        vehicleId: { type: Schema.Types.ObjectId, ref: 'OwnedVehicle', required: true, index: true },
        serviceType: {
            type: String,
            enum: ['OIL_CHANGE', 'TIRES', 'BRAKES', 'INSPECTION', 'OTHER'],
            required: true
        },
        date: { type: Date, default: Date.now, required: true },
        mileageAtService: { type: Number, required: true },
        locationName: { type: String, required: true },
        cost: { type: Number },
        notes: { type: String },
    },
    {
        timestamps: true,
    }
);

export const ServiceRecord = mongoose.models.ServiceRecord || mongoose.model<IServiceRecord>('ServiceRecord', ServiceRecordSchema);
