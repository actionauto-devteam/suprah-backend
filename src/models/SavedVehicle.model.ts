import mongoose, { Document, Schema } from 'mongoose';

export interface ISavedVehicle extends Document {
    userId: mongoose.Types.ObjectId;
    vehicleId: mongoose.Types.ObjectId;
    savedAt: Date;
}

const SavedVehicleSchema: Schema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
        savedAt: { type: Date, default: Date.now },
    },
    { timestamps: false }
);

SavedVehicleSchema.index({ userId: 1, vehicleId: 1 }, { unique: true });

export const SavedVehicle = mongoose.models.SavedVehicle || mongoose.model<ISavedVehicle>('SavedVehicle', SavedVehicleSchema);
