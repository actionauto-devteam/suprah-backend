import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import {
  AuctionListing,
  PHOTO_SLOTS,
  REQUIRED_PHOTO_SLOTS,
  LISTING_STATUSES,
  ACTIVE_LISTING_STATUSES,
  EDITABLE_LISTING_STATUSES,
} from "../models/AuctionListing.model";
import storageService from "../services/storage.service";
import mongoose from "mongoose";

const EDITABLE_FIELDS = [
  "ownedVehicleId",
  "vin",
  "year",
  "make",
  "model",
  "trim",
  "bodyStyle",
  "mileage",
  "transmission",
  "fuelType",
  "driveTrain",
  "engine",
  "exteriorColor",
  "interiorColor",
  "doors",
  "seats",
  "condition",
  "titleStatus",
  "ownersCount",
  "keysCount",
  "hasAccidentHistory",
  "accidentNotes",
  "hasServiceHistory",
  "knownIssues",
  "features",
  "askingPrice",
  "isNegotiable",
  "description",
  "contactPreference",
] as const;

const MAX_EXTRA_PHOTOS = 6;
const MAX_TOTAL_PHOTOS = 15;

const serialize = (listing: any) => ({
  ...listing.toObject(),
  id: listing._id.toString(),
});

const sanitizePayload = (body: Record<string, any>) => {
  const payload: Record<string, any> = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    payload[field] = body[field] === "" ? undefined : body[field];
  }
  if (payload.vin) payload.vin = String(payload.vin).toUpperCase().trim();
  return payload;
};

const assertNoActiveVinConflict = async (
  userId: any,
  vin: string,
  excludeId?: string,
) => {
  const query: Record<string, any> = {
    userId,
    vin,
    status: { $in: [...ACTIVE_LISTING_STATUSES] },
  };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await AuctionListing.findOne(query);
  if (existing) {
    throw new ApiError(400, "You already have an active listing for this VIN");
  }
};

const getOwnedListing = async (id: string, userId: any) => {
  const listing = await AuctionListing.findOne({ _id: id, userId });
  if (!listing) {
    throw new ApiError(404, "Listing not found");
  }
  return listing;
};

const requireAuth = (req: Request) => {
  const userId = req.user?._id;
  if (!userId) {
    throw new ApiError(401, "Please authenticate");
  }
  return userId;
};

export const createListing = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const payload = sanitizePayload(req.body);

    if (payload.vin) {
      await assertNoActiveVinConflict(userId, payload.vin);
    }

    const now = new Date();
    const listing = await AuctionListing.create({
      ...payload,
      userId,
      status: "DRAFT",
      statusHistory: [{ status: "DRAFT", at: now, note: "Listing created" }],
    });

    res.status(201).json({ success: true, data: serialize(listing) });
  },
);

export const getListings = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const { status } = req.query;

    const filter: Record<string, any> = { userId };
    if (status && LISTING_STATUSES.includes(status as any)) {
      filter.status = status;
    }

    const [listings, grouped] = await Promise.all([
      AuctionListing.find(filter).sort({ updatedAt: -1 }),
      AuctionListing.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
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

export const getListing = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireAuth(req);
  const listing = await getOwnedListing(req.params.id, userId);
  res.status(200).json({ success: true, data: serialize(listing) });
});

export const updateListing = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const listing = await getOwnedListing(req.params.id, userId);

    if (!EDITABLE_LISTING_STATUSES.includes(listing.status)) {
      throw new ApiError(403, "This listing can no longer be edited");
    }

    const payload = sanitizePayload(req.body);
    if (payload.vin && payload.vin !== listing.vin) {
      await assertNoActiveVinConflict(userId, payload.vin, listing.id);
    }

    Object.assign(listing, payload);
    await listing.save();

    res.status(200).json({ success: true, data: serialize(listing) });
  },
);

export const submitListing = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const listing = await getOwnedListing(req.params.id, userId);

    if (!EDITABLE_LISTING_STATUSES.includes(listing.status)) {
      throw new ApiError(400, "This listing cannot be submitted");
    }

    const missingFields: string[] = [];
    if (!listing.vin || listing.vin.length !== 17) missingFields.push("vin");
    if (!listing.year) missingFields.push("year");
    if (!listing.make) missingFields.push("make");
    if (!listing.model) missingFields.push("model");
    if (!listing.mileage || listing.mileage <= 0) missingFields.push("mileage");
    if (!listing.condition) missingFields.push("condition");
    if (!listing.titleStatus) missingFields.push("titleStatus");
    if (!listing.transmission) missingFields.push("transmission");
    if (!listing.fuelType) missingFields.push("fuelType");
    if (!listing.exteriorColor) missingFields.push("exteriorColor");
    if (!listing.askingPrice || listing.askingPrice <= 0)
      missingFields.push("askingPrice");
    if (!listing.description?.trim()) missingFields.push("description");

    const filledSlots = new Set(listing.photos.map((p: any) => p.slot));
    for (const slot of REQUIRED_PHOTO_SLOTS) {
      if (!filledSlots.has(slot)) missingFields.push(`photo:${slot}`);
    }

    if (missingFields.length > 0) {
      throw new ApiError(
        400,
        "Please complete all required fields before submitting",
        missingFields,
      );
    }

    await assertNoActiveVinConflict(userId, listing.vin, listing.id);

    listing.status = "UNDER_REVIEW";
    listing.submittedAt = new Date();
    listing.rejectionReason = undefined;
    listing.reviewedAt = undefined;
    listing.reviewedBy = undefined;
    listing.statusHistory.push({
      status: "UNDER_REVIEW",
      at: new Date(),
      note: "Submitted for dealership review",
    });
    await listing.save();

    res.status(200).json({ success: true, data: serialize(listing) });
  },
);

export const withdrawListing = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const listing = await getOwnedListing(req.params.id, userId);

    if (listing.status !== "UNDER_REVIEW") {
      throw new ApiError(400, "Only listings under review can be withdrawn");
    }

    listing.status = "WITHDRAWN";
    listing.withdrawnAt = new Date();
    listing.statusHistory.push({
      status: "WITHDRAWN",
      at: new Date(),
      note: "Withdrawn by seller",
    });
    await listing.save();

    res.status(200).json({ success: true, data: serialize(listing) });
  },
);

export const deleteListing = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const listing = await getOwnedListing(req.params.id, userId);

    if (!EDITABLE_LISTING_STATUSES.includes(listing.status)) {
      throw new ApiError(403, "This listing cannot be deleted");
    }

    for (const photo of listing.photos) {
      try {
        await storageService.delete(photo.url);
      } catch {}
    }

    await listing.deleteOne();

    res.status(200).json({ success: true, data: { id: req.params.id } });
  },
);

export const uploadListingPhotoHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const { slot } = req.params;
    const file = req.file;

    if (!PHOTO_SLOTS.includes(slot as any)) {
      throw new ApiError(400, "Invalid photo slot");
    }
    if (!file) {
      throw new ApiError(400, "An image file is required");
    }

    const listing = await getOwnedListing(req.params.id, userId);
    if (!EDITABLE_LISTING_STATUSES.includes(listing.status)) {
      throw new ApiError(403, "Photos can no longer be changed on this listing");
    }

    if (slot === "EXTRA") {
      const extras = listing.photos.filter((p: any) => p.slot === "EXTRA");
      if (extras.length >= MAX_EXTRA_PHOTOS) {
        throw new ApiError(400, `Maximum of ${MAX_EXTRA_PHOTOS} extra photos allowed`);
      }
      if (listing.photos.length >= MAX_TOTAL_PHOTOS) {
        throw new ApiError(400, `Maximum of ${MAX_TOTAL_PHOTOS} photos allowed`);
      }
    }

    const url = await storageService.upload(file, "auction-listings");

    if (slot !== "EXTRA") {
      const previous = listing.photos.find((p: any) => p.slot === slot);
      if (previous) {
        try {
          await storageService.delete(previous.url);
        } catch {}
        listing.photos = listing.photos.filter((p: any) => p.slot !== slot);
      }
    }

    listing.photos.push({ slot, url });
    await listing.save();

    res.status(200).json({ success: true, data: serialize(listing) });
  },
);

export const deleteListingPhoto = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAuth(req);
    const { slot } = req.params;
    const url = (req.body?.url || req.query?.url) as string | undefined;

    if (!PHOTO_SLOTS.includes(slot as any)) {
      throw new ApiError(400, "Invalid photo slot");
    }

    const listing = await getOwnedListing(req.params.id, userId);
    if (!EDITABLE_LISTING_STATUSES.includes(listing.status)) {
      throw new ApiError(403, "Photos can no longer be changed on this listing");
    }

    if (slot === "EXTRA" && !url) {
      throw new ApiError(400, "Photo URL is required to remove an extra photo");
    }

    const target = listing.photos.find(
      (p: any) => p.slot === slot && (!url || p.url === url),
    );
    if (!target) {
      throw new ApiError(404, "Photo not found");
    }

    try {
      await storageService.delete(target.url);
    } catch {}

    listing.photos = listing.photos.filter((p: any) => p !== target);
    await listing.save();

    res.status(200).json({ success: true, data: serialize(listing) });
  },
);
