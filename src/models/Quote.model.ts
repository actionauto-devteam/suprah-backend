import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IQuote extends Document {
    // Customer Information
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    organizationId: string;

    // Vehicle Information (populated from Vehicle model or manually entered)
    vehicleId?: mongoose.Types.ObjectId;
    vehicleName?: string;
    vehicleImage?: string;
    vin?: string;
    stockNumber?: string;
    vehiclePrice?: number;
    vehicleMarketPrice?: number;
    vehicleLocation?: string;
    vehicleStatus?: string;
    daysOnLot?: number;

    // Shipping Information
    fromZip: string;
    toZip: string;
    fromAddress: string;
    toAddress: string;
    units: number;
    enclosedTrailer: boolean;
    vehicleInoperable: boolean;

    // Calculated Fields
    miles: number;
    rate: number;
    eta: {
        min: number;
        max: number;
    };

    // Status
    status: 'pending' | 'accepted' | 'rejected' | 'booked';

    // Timestamps
    createdAt: Date;
    updatedAt: Date;
}

const QuoteSchema: Schema<IQuote> = new Schema(
    {
        // Customer Information
        firstName: { type: String, required: true, trim: true },
        lastName: { type: String, required: true, trim: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        phone: { type: String, required: true, trim: true },
        organizationId: {
            type: String,
            required: true,
            index: true
        },

        // Vehicle Information
        vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
        vehicleName: { type: String, trim: true },
        vehicleImage: { type: String, trim: true },
        vin: { type: String, trim: true },
        stockNumber: { type: String, trim: true },
        vehiclePrice: { type: Number },
        vehicleMarketPrice: { type: Number },
        vehicleLocation: { type: String, trim: true },
        vehicleStatus: { type: String, trim: true },
        daysOnLot: { type: Number },

        // Shipping Information
        fromZip: { type: String, required: true, trim: true },
        toZip: { type: String, required: true, trim: true },
        fromAddress: { type: String, required: true, trim: true },
        toAddress: { type: String, required: true, trim: true },
        units: { type: Number, required: true, min: 1, max: 5, default: 1 },
        enclosedTrailer: { type: Boolean, default: false },
        vehicleInoperable: { type: Boolean, default: false },

        // Calculated Fields
        miles: { type: Number, required: true },
        rate: { type: Number, required: true },
        eta: {
            min: { type: Number, required: true },
            max: { type: Number, required: true }
        },

        // Status
        status: {
            type: String,
            enum: ['pending', 'accepted', 'rejected', 'booked'],
            default: 'pending'
        }
    },
    {
        timestamps: true
    }
);

const Quote = mongoose.model<IQuote>('Quote', QuoteSchema);

export default Quote;