import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { AuctionListing, LISTING_STATUSES } from "../models/AuctionListing.model";
import Vehicle from "../models/Vehicle.model";
import mongoose from "mongoose";

const serialize = (listing: any) => ({
    ...listing.toObject(),
    id: listing._id.toString(),
});

export const getReviewListings = asyncHandler(
    async (req: Request, res: Response) => {
        const { status } = req.query;

        const filter: Record<string, any> = {};
        if (status && LISTING_STATUSES.includes(status as any)) {
            filter.status = status;
        }

        const [listings, grouped] = await Promise.all([
            AuctionListing.find(filter)
                .sort({ submittedAt: -1, updatedAt: -1 })
                .populate("userId", "name email phone"),
            AuctionListing.aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
        ]);

        const counts: Record<string, number> = { ALL: 0 };
        for (const s of LISTING_STATUSES) counts[s] = 0;
        for (const g of grouped) {
            counts[g._id] = g.count;
            counts.ALL += g.count;
        }

        res.status(200).json({
            success: true,
            counts,
            data: listings.map(serialize),
        });
    },
);

export const getReviewListing = asyncHandler(
    async (req: Request, res: Response) => {
        const listing = await AuctionListing.findById(req.params.id).populate(
            "userId",
            "name email phone",
        );
        if (!listing) {
            throw new ApiError(404, "Listing not found");
        }
        res.status(200).json({ success: true, data: serialize(listing) });
    },
);

const MIN_VEHICLE_YEAR = 1980;

export const approveListing = asyncHandler(
    async (req: Request, res: Response) => {
        const actor = req.crmUser;
        if (!actor) {
            throw new ApiError(401, "CRM authentication required");
        }

        const listing = await AuctionListing.findById(req.params.id).populate(
            "userId",
            "name email",
        );
        if (!listing) {
            throw new ApiError(404, "Listing not found");
        }
        if (listing.status !== "UNDER_REVIEW") {
            throw new ApiError(400, "Only listings under review can be approved");
        }

        const vin = listing.vin?.toUpperCase().trim();
        const year = Number(listing.year);
        const maxYear = new Date().getFullYear() + 1;
        const missing: string[] = [];
        if (!vin || vin.length !== 17) missing.push("vin");
        if (!Number.isInteger(year) || year < MIN_VEHICLE_YEAR || year > maxYear) missing.push("year");
        if (!listing.make?.trim()) missing.push("make");
        if (!listing.model?.trim()) missing.push("model");
        if (!listing.mileage || listing.mileage <= 0) missing.push("mileage");
        if (!listing.askingPrice || listing.askingPrice <= 0) missing.push("askingPrice");
        if (!listing.photos?.length) missing.push("photos");
        if (missing.length > 0) {
            throw new ApiError(
                400,
                `This listing is missing required data and cannot be approved yet: ${missing.join(", ")}`,
                missing,
            );
        }

        const existingVehicle = await Vehicle.findOne({ vin });
        if (existingVehicle) {
            throw new ApiError(
                409,
                `A vehicle with VIN ${vin} already exists in inventory (status: ${existingVehicle.status}). Resolve the conflict manually before approving this listing.`,
            );
        }

        const { reviewerNotes } = req.body as { reviewerNotes?: string };
        const seller = listing.userId as any;
        const sellerLabel = seller?.name || seller?.email || "customer";

        let vehicle;
        try {
            vehicle = await Vehicle.create({
                vin,
                year,
                make: listing.make,
                modelName: listing.model,
                trim: listing.trim,
                exteriorColor: listing.exteriorColor,
                interiorColor: listing.interiorColor,
                bodyStyle: listing.bodyStyle,
                mileage: listing.mileage,
                transmission: listing.transmission,
                engine: listing.engine,
                fuelType: listing.fuelType,
                driveTrain: listing.driveTrain,
                doors: listing.doors,
                price: listing.askingPrice,
                images: listing.photos.map((p: any) => p.url),
                status: "In Recon",
                dateAdded: new Date(),
                organizationId: req.orgId,
                notes: [
                    {
                        text: `Acquired via customer auction listing (seller: ${sellerLabel}).`,
                        author: actor._id,
                        date: new Date(),
                    },
                ],
            });
        } catch (err: any) {
            if (err?.code === 11000) {
                throw new ApiError(409, `A vehicle with VIN ${vin} already exists in inventory.`);
            }
            throw err;
        }

        try {
            listing.status = "APPROVED";
            listing.reviewedAt = new Date();
            listing.reviewedBy = actor._id as unknown as mongoose.Types.ObjectId;
            listing.reviewerNotes = reviewerNotes;
            listing.rejectionReason = undefined;
            listing.convertedVehicleId = vehicle._id as unknown as mongoose.Types.ObjectId;
            listing.statusHistory.push({
                status: "APPROVED",
                at: new Date(),
                note: reviewerNotes || "Approved by reviewer",
            });
            await listing.save();
        } catch (err) {
            // The listing failed to update after the vehicle record was created —
            // roll back the vehicle so we never leave an orphan/duplicate record
            // sitting in the dealership's live inventory.
            await Vehicle.deleteOne({ _id: vehicle._id });
            throw err;
        }

        res.status(200).json({ success: true, data: serialize(listing) });
    },
);

export const rejectListing = asyncHandler(
    async (req: Request, res: Response) => {
        const actor = req.crmUser;
        if (!actor) {
            throw new ApiError(401, "CRM authentication required");
        }

        const { rejectionReason, reviewerNotes } = req.body as {
            rejectionReason?: string;
            reviewerNotes?: string;
        };
        if (!rejectionReason?.trim()) {
            throw new ApiError(400, "A rejection reason is required");
        }

        const listing = await AuctionListing.findById(req.params.id);
        if (!listing) {
            throw new ApiError(404, "Listing not found");
        }
        if (listing.status !== "UNDER_REVIEW") {
            throw new ApiError(400, "Only listings under review can be rejected");
        }

        listing.status = "REJECTED";
        listing.reviewedAt = new Date();
        listing.reviewedBy = actor._id as unknown as mongoose.Types.ObjectId;
        listing.rejectionReason = rejectionReason;
        listing.reviewerNotes = reviewerNotes;
        listing.statusHistory.push({
            status: "REJECTED",
            at: new Date(),
            note: rejectionReason,
        });
        await listing.save();

        res.status(200).json({ success: true, data: serialize(listing) });
    },
);
