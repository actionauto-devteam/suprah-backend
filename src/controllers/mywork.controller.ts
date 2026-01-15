import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Vehicle from '../models/Vehicle.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';

const getMyWork = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)?._id; // Assumes auth middleware populates user
    const { filter } = req.query;

    const query: any = { assignedTo: userId, status: 'In Recon' };

    if (filter === 'overdue') {
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        query.stepEnteredAt = { $lt: threeDaysAgo };
    }

    const vehicles = await Vehicle.find(query).sort({ stepEnteredAt: 1 });

    res.json(new ApiResponse(200, vehicles, 'My Work items fetched successfully'));
});

const updateStep = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { nextStep, assignedTo } = req.body;

    const vehicle = await Vehicle.findById(id);
    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }

    if (nextStep) {
        vehicle.currentStep = nextStep;
        vehicle.stepEnteredAt = new Date();
    }

    if (assignedTo) {
        vehicle.assignedTo = assignedTo;
    }

    if (nextStep === 'Ready') {
        vehicle.status = 'Ready for Sale';
    }

    await vehicle.save();
    res.json(new ApiResponse(200, vehicle, 'Workflow step updated'));
});

const addNote = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { text } = req.body;
    const userId = (req.user as IUser)?._id;

    const vehicle = await Vehicle.findById(id);
    if (!vehicle) {
        throw new ApiError(404, 'Vehicle not found');
    }

    vehicle.notes.push({
        text,
        author: userId,
        date: new Date()
    });

    await vehicle.save();
    res.json(new ApiResponse(200, vehicle, 'Note added successfully'));
});

export default {
    getMyWork,
    updateStep,
    addNote
};
