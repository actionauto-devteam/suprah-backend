// services/user.service.ts

import User, { IUser } from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import bcrypt from 'bcryptjs';
import { Document } from 'mongoose';

// Helper type for lean documents
type LeanUser = Omit<IUser, keyof Document> & { _id: string };

class UserService {
    /**
     * Create a new user
     */
    async createUser(userData: Partial<IUser>): Promise<IUser> {
        const { email, password, name, role } = userData;

        // Check if user already exists
        const existingUser = await User.findOne({ email: email?.toLowerCase() });
        if (existingUser) {
            throw new ApiError(400, 'Email already registered');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password as string, 10);

        // Create user
        const user = await User.create({
            email: email?.toLowerCase(),
            password: hashedPassword,
            name,
            role: role || 'user'
        });

        return user;
    }

    /**
     * Get user by ID
     */
    async getUserById(userId: string): Promise<IUser> {
        const user = await User.findById(userId).select('-password');
        
        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        return user;
    }

    /**
     * Get user by email
     */
    async getUserByEmail(email: string): Promise<IUser | null> {
        return await User.findOne({ email: email.toLowerCase() });
    }

    /**
     * Update user
     */
    async updateUser(userId: string, updateData: Partial<IUser>): Promise<IUser> {
        // Don't allow updating sensitive fields through this method
        const { password, email, role, ...safeData } = updateData as any;

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: safeData },
            { new: true, runValidators: true }
        ).select('-password');

        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        return user;
    }

    /**
     * Search users by name or email
     */
    async searchUsers(
        query: string,
        limit: number = 10,
        excludeUserId?: string
    ): Promise<Array<{_id: string; name: string; email: string; avatar?: string; role: string}>> {
        const searchRegex = new RegExp(query, 'i');

        const searchCriteria: any = {
            $or: [
                { name: searchRegex },
                { email: searchRegex }
            ]
        };

        // Exclude current user if specified
        if (excludeUserId) {
            searchCriteria._id = { $ne: excludeUserId };
        }

        const users = await User.find(searchCriteria)
            .select('_id name email avatar role')
            .limit(limit)
            .lean()
            .exec();

        // Transform to plain objects with proper typing
        return users.map(user => ({
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            role: user.role
        }));
    }

    /**
     * Update user password
     */
    async updatePassword(userId: string, newPassword: string): Promise<void> {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await User.findByIdAndUpdate(userId, {
            password: hashedPassword
        });
    }

    /**
     * Verify user password
     */
    async verifyPassword(userId: string, password: string): Promise<boolean> {
        const user = await User.findById(userId).select('+password');
        
        if (!user || !user.password) {
            return false;
        }

        return await bcrypt.compare(password, user.password);
    }

    /**
     * Delete user (soft delete by setting isActive to false)
     */
    async deleteUser(userId: string): Promise<void> {
        const user = await User.findById(userId);
        
        if (!user) {
            throw new ApiError(404, 'User not found');
        }

        // Soft delete
        user.isActive = false;
        await user.save();
    }

    /**
     * Get all users (admin only)
     */
    async getAllUsers(options: {
        page?: number;
        limit?: number;
        role?: string;
        isActive?: boolean;
    } = {}): Promise<{ 
        users: Array<{_id: string; name: string; email: string; avatar?: string; role: string; isActive: boolean}>; 
        total: number 
    }> {
        const {
            page = 1,
            limit = 20,
            role,
            isActive
        } = options;

        const query: any = {};
        if (role) query.role = role;
        if (isActive !== undefined) query.isActive = isActive;

        const skip = (page - 1) * limit;

        const [usersData, total] = await Promise.all([
            User.find(query)
                .select('-password')
                .skip(skip)
                .limit(limit)
                .sort({ createdAt: -1 })
                .lean()
                .exec(),
            User.countDocuments(query)
        ]);

        // Transform to plain objects with proper typing
        const users = usersData.map(user => ({
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            role: user.role,
            isActive: user.isActive
        }));

        return { users, total };
    }
}

export default new UserService();