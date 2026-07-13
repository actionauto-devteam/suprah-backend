import mongoose, { Document, Schema } from 'mongoose';

export interface IOwnedVehicle {
    userId: mongoose.Types.ObjectId;
    vin: string;
    make: string;
    model: string;
    year: string;
    trim?: string;
    color?: string;
    licensePlate?: string;
    currentMileage: number;
    purchaseDate?: Date;
    status: 'ACTIVE' | 'SOLD' | 'TRADED_IN';
    images: string[];
    source?: 'MANUAL' | 'DEALERSHIP_TRANSFER';
    dealershipName?: string;
    transferredAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const OwnedVehicleSchema: Schema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        vin: { type: String, required: true },
        make: { type: String, required: true },
        model: { type: String, required: true },
        year: { type: String, required: true },
        trim: { type: String },
        color: { type: String },
        licensePlate: { type: String },
        currentMileage: { type: Number, default: 0 },
        purchaseDate: { type: Date },
        status: { type: String, enum: ['ACTIVE', 'SOLD', 'TRADED_IN'], default: 'ACTIVE' },
        images: [{ type: String }],
        source: { type: String, enum: ['MANUAL', 'DEALERSHIP_TRANSFER'], default: 'MANUAL' },
        dealershipName: { type: String },
        transferredAt: { type: Date },
    },
    {
        timestamps: true,
    }
);

OwnedVehicleSchema.index({ userId: 1, vin: 1 }, { unique: true });

export const OwnedVehicle = mongoose.models.OwnedVehicle || mongoose.model<IOwnedVehicle>('OwnedVehicle', OwnedVehicleSchema);