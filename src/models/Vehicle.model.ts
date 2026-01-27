import mongoose, { Document, Schema, Model, Query } from 'mongoose';

export interface IVehicle extends Document {
    // Basic Information
    vin: string;
    year: number;
    make: string;
    modelName: string;
    trim?: string;
    exteriorColor?: string;
    interiorColor?: string;
    stockNumber?: string;
    vehicleType?: string;
    bodyStyle?: string;

    // Pricing
    price?: number;
    msrp?: number;
    cost?: number;

    // Details
    mileage?: number;
    transmission?: string;
    engine?: string;
    fuelType?: string;
    driveTrain?: string;
    doors?: number;
    cylinders?: number;
    options?: string;
    comments?: string;
    images?: string[];
    vdpUrl?: string;

    // Dealer Info
    dealerId?: string;
    dealerName?: string;
    dealerAddress?: string;
    dealerCity?: string;
    dealerState?: string;
    dealerZip?: string;
    dealerEmail?: string;

    // Status & Logic
    certified?: boolean;
    isNewVehicle?: boolean;
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
        exteriorColor: { type: String, trim: true },
        interiorColor: { type: String, trim: true },
        stockNumber: { type: String, trim: true, index: true, sparse: true },
        vehicleType: { type: String, trim: true },
        bodyStyle: { type: String, trim: true },

        // Pricing
        price: { type: Number },
        msrp: { type: Number },
        cost: { type: Number },

        // Details
        mileage: { type: Number },
        transmission: { type: String, trim: true },
        engine: { type: String, trim: true },
        fuelType: { type: String, trim: true },
        driveTrain: { type: String, trim: true },
        doors: { type: Number },
        cylinders: { type: Number },
        options: { type: String, trim: true },
        comments: { type: String, trim: true },
        images: [{ type: String, trim: true }],
        vdpUrl: { type: String, trim: true },

        // Dealer Info
        dealerId: { type: String, trim: true },
        dealerName: { type: String, trim: true },
        dealerAddress: { type: String, trim: true },
        dealerCity: { type: String, trim: true },
        dealerState: { type: String, trim: true },
        dealerZip: { type: String, trim: true },
        dealerEmail: { type: String, trim: true },

        // Status & Logic
        certified: { type: Boolean, default: false },
        isNewVehicle: { type: Boolean, default: false },
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