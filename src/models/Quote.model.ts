import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IQuoteLocation {
    name?: string;
    streetAddress?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
}

export interface IQuote extends Document {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    organizationId: string;
    createdBy?: mongoose.Types.ObjectId;

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

    fromZip: string;
    toZip: string;
    fromAddress: string;
    toAddress: string;
    fromLocation?: IQuoteLocation | null;
    toLocation?: IQuoteLocation | null;
    units: number;
    enclosedTrailer: boolean;
    vehicleInoperable: boolean;

    miles: number;
    rate: number;
    eta: {
        min: number;
        max: number;
    };

    status: 'pending' | 'accepted' | 'rejected' | 'booked';

    // Set only on requests customers send from the customer portal; staff
    // quotes leave both empty.
    source?: 'customer_portal';
    requestedBy?: mongoose.Types.ObjectId;

    // The dealership's CRM lead for this customer (matched by email, then
    // phone) and that lead's customer record, when there is one.
    leadId?: mongoose.Types.ObjectId | null;
    customerRecordId?: mongoose.Types.ObjectId | null;

    // Set when a waiting customer request was closed because its vehicle
    // left the marketplace (sold, removed or no longer for sale).
    closedReason?: 'vehicle_unavailable';
    closedAt?: Date;

    createdAt: Date;
    updatedAt: Date;
}

const quoteLocationSchema = new Schema(
    {
        name: { type: String, trim: true, default: "" },
        // Recommended at Quote stage, not required. 
        streetAddress: { type: String, trim: true, default: "" },
        city: { type: String, required: true, trim: true },
        state: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            minlength: 2,
            maxlength: 2,
        },
        zip: {
            type: String,
            required: true,
            trim: true,
            match: /^\d{5}(-\d{4})?$/,
        },
        country: {
            type: String,
            trim: true,
            uppercase: true,
            maxlength: 3,
            default: "US",
        },
    },
    { _id: false },
);

const QuoteSchema: Schema<IQuote> = new Schema(
    {
        firstName: { type: String, required: true, trim: true },
        lastName: { type: String, required: true, trim: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        phone: { type: String, required: true, trim: true },
        organizationId: {
            type: String,
            required: true,
            index: true
        },
        createdBy: { type: Schema.Types.ObjectId, ref: 'User' },

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

        fromZip: { type: String, required: true, trim: true },
        toZip: { type: String, required: true, trim: true },
        fromAddress: { type: String, required: true, trim: true },
        toAddress: { type: String, required: true, trim: true },

        // New structured representation. Optional so historical quotes remain
        // valid without a migration; legacy fields above stay authoritative
        // for old records.
        fromLocation: { type: quoteLocationSchema, required: false, default: undefined },
        toLocation: { type: quoteLocationSchema, required: false, default: undefined },
        units: { type: Number, required: true, min: 1, max: 5, default: 1 },
        enclosedTrailer: { type: Boolean, default: false },
        vehicleInoperable: { type: Boolean, default: false },

        miles: { type: Number, required: true },
        rate: { type: Number, required: true },
        eta: {
            min: { type: Number, required: true },
            max: { type: Number, required: true }
        },

        status: {
            type: String,
            enum: ['pending', 'accepted', 'rejected', 'booked'],
            default: 'pending'
        },

        source: { type: String, enum: ['customer_portal'], default: undefined },
        requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
        customerRecordId: { type: Schema.Types.ObjectId, ref: 'Customer' },
        closedReason: { type: String, enum: ['vehicle_unavailable'], default: undefined },
        closedAt: { type: Date }
    },
    {
        timestamps: true
    }
);

// One pending customer-portal request per customer, vehicle and destination, so
// two devices sending the same request at the same moment can't both create one.
// Staff quotes have no source and are never affected.
QuoteSchema.index(
    { requestedBy: 1, vehicleId: 1, toZip: 1 },
    {
        unique: true,
        partialFilterExpression: { source: 'customer_portal', status: 'pending' },
        name: 'one_pending_customer_request',
    }
);

const Quote = mongoose.model<IQuote>('Quote', QuoteSchema);

export default Quote;