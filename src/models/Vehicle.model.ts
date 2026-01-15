import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IVehicle extends Document {
    vin: string;
    year: number;
    make: string;
    modelName: string;
    trim?: string;
    color?: string;
    stockNumber?: string;
    status: 'In Recon' | 'Ready for Sale' | 'Sold';
    currentStep: 'Inspection' | 'Mechanical' | 'Body / Paint' | 'Detail' | 'Photography' | 'Ready';
    assignedTo?: mongoose.Types.ObjectId;
    reconStartDate?: Date;
    stepEnteredAt?: Date;
    notes: Array<{
        text: string;
        author: mongoose.Types.ObjectId;
        date: Date;
    }>;
}

export interface IVehicleModel extends Model<IVehicle> {
    paginate(filter: any, options: any): Promise<any>; // Add if you use pagination plugin
}

const VehicleSchema: Schema<IVehicle> = new Schema(
    {
        vin: { type: String, required: true, unique: true, trim: true },
        year: { type: Number, required: true },
        make: { type: String, required: true, trim: true },
        modelName: { type: String, required: true, trim: true },
        trim: { type: String, trim: true },
        color: { type: String, trim: true },
        stockNumber: { type: String, trim: true },
        status: {
            type: String,
            enum: ['In Recon', 'Ready for Sale', 'Sold'],
            default: 'In Recon',
        },
        currentStep: {
            type: String,
            enum: ['Inspection', 'Mechanical', 'Body / Paint', 'Detail', 'Photography', 'Ready'],
            default: 'Inspection',
        },
        assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
        reconStartDate: { type: Date, default: Date.now },
        stepEnteredAt: { type: Date, default: Date.now },
        notes: [
            {
                text: { type: String, required: true },
                author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
                date: { type: Date, default: Date.now },
            },
        ],
    },
    {
        timestamps: true,
    }
);

// Add plugins if needed (toJSON, paginate)
// VehicleSchema.plugin(toJSON);
// VehicleSchema.plugin(paginate);

const Vehicle = mongoose.model<IVehicle, IVehicleModel>('Vehicle', VehicleSchema);

export default Vehicle;
