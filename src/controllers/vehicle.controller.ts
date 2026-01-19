import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

const createVehicle = asyncHandler(async (req: Request, res: Response) => {
    const vehicle = await Vehicle.create(req.body);
    res.status(201).json(new ApiResponse(201, vehicle, 'Vehicle created successfully'));
});

const getVehicles = asyncHandler(async (req: Request, res: Response) => {
    const vehicles = await Vehicle.find().populate('assignedTo', 'email name');
    res.json(new ApiResponse(200, vehicles, 'Vehicles fetched successfully'));
});

const getVehicleById = asyncHandler(async (req: Request, res: Response) => {
    const vehicle = await Vehicle.findById(req.params.id).populate('assignedTo', 'email name');
    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }
    res.json(new ApiResponse(200, vehicle, 'Vehicle fetched successfully'));
});

const updateVehicle = asyncHandler(async (req: Request, res: Response) => {
    const vehicle = await Vehicle.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }
    res.json(new ApiResponse(200, vehicle, 'Vehicle updated successfully'));
});

export default {
    createVehicle,
    getVehicles,
    getVehicleById,
    updateVehicle,
};
