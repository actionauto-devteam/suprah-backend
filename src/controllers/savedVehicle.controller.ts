import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { SavedVehicle } from '../models/SavedVehicle.model';
import Vehicle from '../models/Vehicle.model';

const normalizeVehicle = (v: any) => ({
    id: v._id.toString(),
    vin: v.vin,
    year: v.year,
    make: v.make,
    model: v.modelName,
    modelName: v.modelName,
    trim: v.trim || '',
    color: v.exteriorColor || 'N/A',
    exteriorColor: v.exteriorColor || 'N/A',
    interiorColor: v.interiorColor || 'N/A',
    stockNumber: v.stockNumber || 'N/A',
    price: v.price || 0,
    mileage: v.mileage || 0,
    transmission: v.transmission || 'Automatic',
    fuelType: v.fuelType || 'Gasoline',
    engine: v.engine || '',
    bodyStyle: v.bodyStyle || '',
    driveTrain: v.driveTrain || '',
    image: v.images && v.images.length > 0
        ? v.images[0]
        : 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop',
    images: v.images || [],
    status: v.status,
    location: v.dealerCity
        ? `${v.dealerCity}${v.dealerState ? ', ' + v.dealerState : ''}`
        : 'Unknown',
    leadCount: v.leadCount || 0,
});

export const getSavedVehicles = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Please authenticate');

    const saved = await SavedVehicle.find({ userId }).sort({ savedAt: -1 });
    const vehicleIds = saved.map(s => s.vehicleId);

    const vehicles = await Vehicle.find({ _id: { $in: vehicleIds } });

    const vehicleMap = new Map(vehicles.map(v => [v._id.toString(), v]));
    const normalized = saved
        .map(s => {
            const v = vehicleMap.get(s.vehicleId.toString());
            return v ? normalizeVehicle(v) : null;
        })
        .filter(Boolean);

    res.status(200).json({ success: true, data: normalized });
});

export const saveVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Please authenticate');

    const { vehicleId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(vehicleId)) throw new ApiError(400, 'Invalid vehicle ID');

    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) throw new ApiError(404, 'Vehicle not found');

    await SavedVehicle.findOneAndUpdate(
        { userId, vehicleId: new mongoose.Types.ObjectId(vehicleId) },
        { userId, vehicleId: new mongoose.Types.ObjectId(vehicleId), savedAt: new Date() },
        { upsert: true, new: true }
    );

    res.status(201).json({ success: true, message: 'Vehicle saved' });
});

export const removeSavedVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, 'Please authenticate');

    const { vehicleId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(vehicleId)) throw new ApiError(400, 'Invalid vehicle ID');

    await SavedVehicle.findOneAndDelete({ userId, vehicleId: new mongoose.Types.ObjectId(vehicleId) });

    res.status(200).json({ success: true, message: 'Vehicle removed from saved' });
});
