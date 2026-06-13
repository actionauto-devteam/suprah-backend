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

        const { reviewerNotes } = req.body as { reviewerNotes?: string };
        const seller = listing.userId as any;
        const sellerLabel = seller?.name || seller?.email || "customer";

        const vehicle = await Vehicle.create({
            vin: listing.vin,
            year: Number(listing.year),
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
