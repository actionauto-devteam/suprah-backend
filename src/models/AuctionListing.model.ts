import mongoose, { Schema } from 'mongoose';

export const PHOTO_SLOTS = ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR_FRONT', 'INTERIOR_REAR', 'ENGINE_BAY', 'TRUNK', 'ODOMETER', 'EXTRA'] as const;
export const REQUIRED_PHOTO_SLOTS = ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR_FRONT'] as const;
export const LISTING_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SOLD', 'WITHDRAWN'] as const;
export const ACTIVE_LISTING_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'APPROVED'] as const;
export const EDITABLE_LISTING_STATUSES = ['DRAFT', 'REJECTED', 'WITHDRAWN'] as const;

export type PhotoSlot = (typeof PHOTO_SLOTS)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export interface IAuctionListing {
    userId: mongoose.Types.ObjectId;
    ownedVehicleId?: mongoose.Types.ObjectId;
    vin?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    bodyStyle?: string;
    mileage?: number;
    transmission?: string;
    fuelType?: string;
    driveTrain?: string;
    engine?: string;
    exteriorColor?: string;
    interiorColor?: string;
    doors?: number;
    seats?: number;
    condition?: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
    titleStatus?: 'CLEAN' | 'SALVAGE' | 'REBUILT' | 'LIEN';
    ownersCount?: number;
    keysCount?: number;
    hasAccidentHistory: boolean;
    accidentNotes?: string;
    hasServiceHistory: boolean;
    knownIssues?: string;
    features: string[];
    askingPrice?: number;
    isNegotiable: boolean;
    description?: string;
    contactPreference: 'APP' | 'PHONE' | 'EMAIL';
    photos: { slot: PhotoSlot; url: string }[];
    status: ListingStatus;
    submittedAt?: Date;
    withdrawnAt?: Date;
    soldAt?: Date;
    rejectionReason?: string;
    reviewerNotes?: string;
    convertedVehicleId?: mongoose.Types.ObjectId;
    reviewedAt?: Date;
    reviewedBy?: mongoose.Types.ObjectId;
    statusHistory: { status: ListingStatus; at: Date; note?: string }[];
    createdAt: Date;
    updatedAt: Date;
}

const AuctionListingSchema: Schema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        ownedVehicleId: { type: Schema.Types.ObjectId, ref: 'OwnedVehicle' },
        vin: { type: String, uppercase: true, trim: true },
        year: { type: String },
        make: { type: String },
        model: { type: String },
        trim: { type: String },
        bodyStyle: { type: String },
        mileage: { type: Number },
        transmission: { type: String },
        fuelType: { type: String },
        driveTrain: { type: String },
        engine: { type: String },
        exteriorColor: { type: String },
        interiorColor: { type: String },
        doors: { type: Number },
        seats: { type: Number },
        condition: { type: String, enum: ['EXCELLENT', 'GOOD', 'FAIR', 'POOR'] },
        titleStatus: { type: String, enum: ['CLEAN', 'SALVAGE', 'REBUILT', 'LIEN'] },
        ownersCount: { type: Number },
        keysCount: { type: Number },
        hasAccidentHistory: { type: Boolean, default: false },
        accidentNotes: { type: String },
        hasServiceHistory: { type: Boolean, default: false },
        knownIssues: { type: String },
        features: [{ type: String }],
        askingPrice: { type: Number },
        isNegotiable: { type: Boolean, default: false },
        description: { type: String },
        contactPreference: { type: String, enum: ['APP', 'PHONE', 'EMAIL'], default: 'APP' },
        photos: [
            {
                slot: { type: String, enum: PHOTO_SLOTS, required: true },
                url: { type: String, required: true },
            },
        ],
        status: { type: String, enum: LISTING_STATUSES, default: 'DRAFT', index: true },
        submittedAt: { type: Date },
        withdrawnAt: { type: Date },
        soldAt: { type: Date },
        rejectionReason: { type: String },
        reviewerNotes: { type: String },
        convertedVehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
        reviewedAt: { type: Date },
        reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        statusHistory: [
            {
                status: { type: String, enum: LISTING_STATUSES, required: true },
                at: { type: Date, required: true },
                note: { type: String },
            },
        ],
    },
    {
        timestamps: true,
    }
);

AuctionListingSchema.index({ userId: 1, status: 1 });
AuctionListingSchema.index(
    { userId: 1, vin: 1 },
    { unique: true, partialFilterExpression: { status: { $in: [...ACTIVE_LISTING_STATUSES] }, vin: { $type: 'string' } } }
);

export const AuctionListing =
    mongoose.models.AuctionListing || mongoose.model<IAuctionListing>('AuctionListing', AuctionListingSchema);
