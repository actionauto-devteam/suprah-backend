import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { SavedVehicle } from '../models/SavedVehicle.model';
import Vehicle from '../models/Vehicle.model';
import membershipService from '../services/membership.service';
import { isOnMarketplace } from '../utils/marketplaceVehicle';
import { wishlistEntries } from '../utils/wishlist';
import { normalizeCustomerVehicle } from './vehicle.controller';

// The Wishlist uses Shop's rules (2026-11-09): only cars for sale can be
// saved, saved cars show the member price like Shop, internal numbers (the
// dealer's cost, how many leads a car has) never reach the customer, and a car
// that's no longer for sale is listed as such so it can be removed.

export const getSavedVehicles = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Your session ended. Sign in again to continue.');

    const saved = await SavedVehicle.find({ userId }).sort({ savedAt: -1 }).lean();
    const savedIds = saved.map((s: any) => s.vehicleId.toString());

    const [vehicles, member] = await Promise.all([
        Vehicle.find({ _id: { $in: savedIds } }).select('-priceHistory -notes').lean(),
        membershipService.getMemberPricingForUser(userId.toString()).catch(() => undefined),
    ]);

    const data = wishlistEntries(savedIds, vehicles as any[], (vehicle) => normalizeCustomerVehicle(vehicle, member));
    res.status(200).json({ success: true, data });
});

export const saveVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Your session ended. Sign in again to continue.');

    const { vehicleId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(vehicleId)) throw new ApiError(400, "This car link isn't valid. Refresh the page and try again.");

    // Only a car that's for sale in Shop can be saved.
    const vehicle = await Vehicle.findById(vehicleId).select('status isArchived isDeleted').lean();
    if (!isOnMarketplace(vehicle as any)) {
        throw new ApiError(404, "This car is no longer available, so it can't be added to your Wishlist.");
    }

    try {
        await SavedVehicle.findOneAndUpdate(
            { userId, vehicleId: new mongoose.Types.ObjectId(vehicleId) },
            { userId, vehicleId: new mongoose.Types.ObjectId(vehicleId), savedAt: new Date() },
            { upsert: true, new: true }
        );
    } catch (error: any) {
        // Two quick taps can both try to add it; the second finds it already saved.
        if (error?.code !== 11000) throw error;
    }

    res.status(201).json({ success: true, message: 'Added to your Wishlist.' });
});

export const removeSavedVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Your session ended. Sign in again to continue.');

    const { vehicleId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(vehicleId)) throw new ApiError(400, "This car link isn't valid. Refresh the page and try again.");

    await SavedVehicle.findOneAndDelete({ userId, vehicleId: new mongoose.Types.ObjectId(vehicleId) });

    res.status(200).json({ success: true, message: 'Removed from your Wishlist.' });
});
