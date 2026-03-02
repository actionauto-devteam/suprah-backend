import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { OwnedVehicle } from '../models/OwnedVehicle.model';
import mongoose from 'mongoose';
import axios from 'axios';

// Create vehicle
export const addOwnedVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, 'Please authenticate');
    }

    const { vin, make, model, year, trim, color, licensePlate, currentMileage } = req.body;

    if (!vin || !make || !model || !year) {
        throw new ApiError(400, 'VIN, Make, Model, and Year are required');
    }

    const existingVehicle = await OwnedVehicle.findOne({ userId, vin });
    if (existingVehicle) {
        throw new ApiError(400, 'You have already registered this vehicle');
    }

    const vehicle = await OwnedVehicle.create({
        userId,
        vin,
        make,
        model,
        year,
        trim,
        color,
        licensePlate,
        currentMileage: currentMileage || 0,
        status: 'ACTIVE'
    });

    res.status(201).json({
        success: true,
        data: vehicle
    });
});

// Get all vehicles for user
export const getOwnedVehicles = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, 'Please authenticate');
    }

    const vehicles = await OwnedVehicle.find({ userId, status: 'ACTIVE' }).sort({ createdAt: -1 });

    res.status(200).json({
        success: true,
        count: vehicles.length,
        data: vehicles
    });
});

// Update mileage
export const updateOwnedVehicleMileage = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, 'Please authenticate');
    }

    const { id } = req.params;
    const { currentMileage } = req.body;

    if (currentMileage === undefined || typeof currentMileage !== 'number') {
        throw new ApiError(400, 'Valid currentMileage is required');
    }

    const vehicle = await OwnedVehicle.findOne({ _id: id, userId });

    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }

    if (currentMileage < vehicle.currentMileage) {
        throw new ApiError(400, 'Mileage cannot be decreased');
    }

    vehicle.currentMileage = currentMileage;
    await vehicle.save();

    res.status(200).json({
        success: true,
        data: vehicle
    });
});

// Decode VIN via NHTSA API
export const decodeVin = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, 'Please authenticate');
    }

    const { vin } = req.params;
    if (!vin || vin.length !== 17) {
        throw new ApiError(400, 'A valid 17-character VIN is required');
    }

    try {
        const response = await axios.get(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
        const result = response.data?.Results?.[0];

        if (!result || !result.Make) {
            throw new ApiError(404, 'Could not decode this VIN');
        }

        res.status(200).json({
            success: true,
            data: {
                make: result.Make,
                model: result.Model,
                year: result.ModelYear,
                trim: result.Trim || result.Series || '',
            }
        });
    } catch (error) {
        console.error('VIN Decode Error:', error);
        throw new ApiError(500, 'Failed to connect to VIN decoding service');
    }
});

// Update vehicle details
export const updateOwnedVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, 'Please authenticate');
    }

    const { id } = req.params;
    const { color, licensePlate, trim, currentMileage, images } = req.body;

    const vehicle = await OwnedVehicle.findOne({ _id: id, userId });
    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }

    if (color !== undefined) vehicle.color = color;
    if (licensePlate !== undefined) vehicle.licensePlate = licensePlate;
    if (trim !== undefined) vehicle.trim = trim;
    if (currentMileage !== undefined) {
        if (currentMileage < vehicle.currentMileage) {
            throw new ApiError(400, 'Mileage cannot be decreased');
        }
        vehicle.currentMileage = currentMileage;
    }
    if (images !== undefined) vehicle.images = images;

    await vehicle.save();

    res.status(200).json({
        success: true,
        data: vehicle
    });
});

// Delete vehicle (soft delete or hard delete; doing hard delete for now or changing status to SOLD)
export const deleteOwnedVehicle = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(401, 'Please authenticate');
    }

    const { id } = req.params;

    const vehicle = await OwnedVehicle.findOneAndDelete({ _id: id, userId });
    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }

    res.status(200).json({
        success: true,
        message: 'Vehicle deleted successfully',
        data: {}
    });
});

