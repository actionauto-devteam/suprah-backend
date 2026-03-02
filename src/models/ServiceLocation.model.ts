import mongoose, { Document, Schema } from 'mongoose';

export interface IServiceLocation extends Document {
    name: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
    partnerName: string;
    location: {
        type: 'Point';
        coordinates: [number, number]; // [longitude, latitude]
    };
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const ServiceLocationSchema = new Schema<IServiceLocation>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        address: {
            type: String,
            required: true,
            trim: true,
        },
        city: {
            type: String,
            required: true,
            trim: true,
        },
        state: {
            type: String,
            required: true,
            trim: true,
            default: 'UT',
        },
        zipCode: {
            type: String,
            required: true,
            trim: true,
        },
        phone: {
            type: String,
            required: true,
            trim: true,
        },
        partnerName: {
            type: String,
            required: true,
            default: 'Jiffy Lube',
        },
        location: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point',
            },
            coordinates: {
                type: [Number],
                required: false, // Optional if we don't have coordinates initially
            },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

// Create a geospatial index for GeoJSON location searches
ServiceLocationSchema.index({ location: '2dsphere' });

const ServiceLocation = mongoose.model<IServiceLocation>('ServiceLocation', ServiceLocationSchema);

export default ServiceLocation;
