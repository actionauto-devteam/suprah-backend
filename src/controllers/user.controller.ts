// controllers/user.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';
import User from '../models/User.model';

const searchUsers = asyncHandler(async (req: Request, res: Response) => {
    const { q, limit = 10, excludeSelf = 'true' } = req.query;
    const currentUserId = (req.user as IUser)._id.toString();
    
    console.log('[UserController] Search request:', { q, limit, excludeSelf, currentUserId });
    
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
        console.log('[UserController] Empty search query, returning empty array');
        return res.json(new ApiResponse(200, [], 'No search query provided'));
    }

    try {
        const searchQuery = q.trim();
        const searchRegex = new RegExp(searchQuery, 'i');
        const limitNum = parseInt(limit as string);

        const searchCriteria: any = {
            $or: [
                { name: searchRegex },
                { email: searchRegex }
            ]
        };

        // Exclude current user if specified
        if (excludeSelf === 'true') {
            searchCriteria._id = { $ne: currentUserId };
        }

        console.log('[UserController] Search criteria:', JSON.stringify(searchCriteria));

        const users = await User.find(searchCriteria)
            .select('_id name email avatar role')
            .limit(limitNum)
            .lean()
            .exec();

        console.log('[UserController] Found users:', users.length);

        // Transform to plain objects with proper typing
        const transformedUsers = users.map(user => ({
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            role: user.role
        }));

        res.json(new ApiResponse(200, transformedUsers, `Found ${transformedUsers.length} users`));
    } catch (error) {
        console.error('[UserController] Search error:', error);
        throw error;
    }
});

const getProfile = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.id || (req.user as IUser)._id.toString();
    
    const user = await User.findById(userId).select('-password');
    
    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }
    
    res.json(new ApiResponse(200, user, 'User profile fetched successfully'));
});

const updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    
    // Don't allow updating sensitive fields through this method
    const { password, email, role, ...safeData } = req.body;

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: safeData },
        { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, 'User not found'));
    }
    
    res.json(new ApiResponse(200, user, 'Profile updated successfully'));
});

export default {
    searchUsers,
    getProfile,
    updateProfile
};