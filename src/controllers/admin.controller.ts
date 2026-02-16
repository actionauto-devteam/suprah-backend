import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

/**
 * Get all organizations with pagination and search
 */
const getAllOrganizations = asyncHandler(async (req: Request, res: Response) => {
    const { page = 1, limit = 10, search } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter: any = {};
    if (search) {
        filter.name = { $regex: search, $options: 'i' };
    }

    const [orgs, total] = await Promise.all([
        Organization.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('ownerId', 'name email'),
        Organization.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.json(new ApiResponse(200, {
        organizations: orgs,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages
        }
    }, 'Organizations fetched successfully'));
});

/**
 * Get all users with pagination and search
 */
const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
    const { page = 1, limit = 10, search } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter: any = {};
    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }

    const [users, total] = await Promise.all([
        User.find(filter)
            .sort({ createdAt: -1 })
            .select('-password') // Exclude password if it existed
            .skip(skip)
            .limit(limitNum)
            .populate('organizationId', 'name'),
        User.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.json(new ApiResponse(200, {
        users,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages
        }
    }, 'Users fetched successfully'));
});

/**
 * Get system-wide statistics
 */
const getSystemStats = asyncHandler(async (req: Request, res: Response) => {
    const [orgCount, userCount] = await Promise.all([
        Organization.countDocuments(),
        User.countDocuments()
    ]);

    res.json(new ApiResponse(200, {
        organizations: orgCount,
        users: userCount
    }, 'System stats fetched successfully'));
});

export default {
    getAllOrganizations,
    getAllUsers,
    getSystemStats
};
