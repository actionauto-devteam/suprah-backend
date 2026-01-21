import mongoose, { Document, Schema, Model, Query } from 'mongoose';

export interface IVehicle extends Document {
    // Basic Information
    vin: string;
    year: number;
    make: string;
    modelName: string;
    trim?: string;
    color?: string;
    stockNumber?: string;

    // Pricing
    price?: number;
    marketPrice?: number;

    // Details
    mileage?: number;
    transmission?: string;
    fuelType?: string;
    location?: string;
    image?: string;

    // Status
    status: 'In Recon' | 'Ready for Sale' | 'Sold' | 'In Transit';
    currentStep?: 'Inspection' | 'Mechanical' | 'Body / Paint' | 'Detail' | 'Photography' | 'Ready';

    // Dates
    reconStartDate?: Date;
    stepEnteredAt?: Date;
    daysOnLot?: number;
    dateAdded?: Date;
    dateSold?: Date;

    // Assignment
    assignedTo?: mongoose.Types.ObjectId;

    // Notes
    notes: Array<{
        text: string;
        author: mongoose.Types.ObjectId;
        date: Date;
    }>;
    isDeleted: boolean;
}

export interface IVehicleModel extends Model<IVehicle> {
    paginate(filter: any, options: any): Promise<any>;
}

const VehicleSchema: Schema<IVehicle> = new Schema(
    {
        // Basic Information
        vin: { type: String, required: true, unique: true, trim: true },
        year: { type: Number, required: true },
        make: { type: String, required: true, trim: true },
        modelName: { type: String, required: true, trim: true },
        trim: { type: String, trim: true },
        color: { type: String, trim: true },
        stockNumber: { type: String, trim: true, unique: true, sparse: true },

        // Pricing
        price: { type: Number },
        marketPrice: { type: Number },

        // Details
        mileage: { type: Number },
        transmission: { type: String, trim: true },
        fuelType: { type: String, trim: true },
        location: { type: String, trim: true },
        image: { type: String, trim: true },

        // Status
        status: {
            type: String,
            enum: ['In Recon', 'Ready for Sale', 'Sold', 'In Transit'],
            default: 'In Recon',
        },
        currentStep: {
            type: String,
            enum: ['Inspection', 'Mechanical', 'Body / Paint', 'Detail', 'Photography', 'Ready'],
            default: 'Inspection',
        },

        // Dates
        reconStartDate: { type: Date, default: Date.now },
        stepEnteredAt: { type: Date, default: Date.now },
        daysOnLot: { type: Number, default: 0 },
        dateAdded: { type: Date, default: Date.now },
        dateSold: { type: Date },

        // Assignment
        assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },

        // Notes
        notes: [
            {
                text: { type: String, required: true },
                author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
                date: { type: Date, default: Date.now },
            },
        ],
        isDeleted: { type: Boolean, default: false },
    },
    {
        timestamps: true,
    }
);

// Update daysOnLot before each query
VehicleSchema.post('find', function (docs: IVehicle[]) {
    docs.forEach((vehicle) => {
        if (vehicle.dateAdded) {
            const days = Math.floor(
                (Date.now() - new Date(vehicle.dateAdded).getTime()) /
                (1000 * 60 * 60 * 24)
            );
            vehicle.daysOnLot = days;
        }
    });
});

const Vehicle = mongoose.model<IVehicle, IVehicleModel>('Vehicle', VehicleSchema);

export default Vehicle;