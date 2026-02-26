import UserActivity, { IUserActivity, ActivityType } from '../models/UserActivity.model';
import mongoose from 'mongoose';

interface CreateActivityParams {
  userId: string;
  organizationId?: string;
  type: ActivityType;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Create a new user activity log
 */
const createActivity = async (params: CreateActivityParams): Promise<IUserActivity> => {
  const activity = await UserActivity.create({
    userId: new mongoose.Types.ObjectId(params.userId),
    organizationId: params.organizationId ? new mongoose.Types.ObjectId(params.organizationId) : undefined,
    type: params.type,
    title: params.title,
    description: params.description,
    metadata: params.metadata,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return activity;
};

/**
 * Get recent activities for a user
 * Maps createdAt to timestamp for frontend compatibility
 */
const getRecentActivities = async (
  userId: string,
  limit = 20,
  skip = 0
): Promise<any[]> => {
  const activities = await UserActivity.find({ userId: new mongoose.Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Map createdAt to timestamp for frontend compatibility
  return activities.map(activity => ({
    ...activity,
    timestamp: activity.createdAt,
  }));
};

/**
 * Get activities for an organization
 */
const getOrganizationActivities = async (
  organizationId: string,
  limit = 50,
  skip = 0
): Promise<any[]> => {
  const activities = await UserActivity.find({ organizationId: new mongoose.Types.ObjectId(organizationId) })
    .populate('userId', 'name email avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return activities;
};

/**
 * Get activity count for a user
 */
const getActivityCount = async (userId: string): Promise<number> => {
  return UserActivity.countDocuments({ userId: new mongoose.Types.ObjectId(userId) });
};

/**
 * Delete old activities (utility function for manual cleanup)
 */
const deleteOldActivities = async (daysOld = 90): Promise<number> => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const result = await UserActivity.deleteMany({
    createdAt: { $lt: cutoffDate },
  });

  return result.deletedCount || 0;
};

/**
 * Log profile update activity
 */
const logProfileUpdate = async (
  userId: string,
  organizationId: string | undefined,
  updatedFields: string[],
  ipAddress?: string,
  userAgent?: string
): Promise<IUserActivity> => {
  return createActivity({
    userId,
    organizationId,
    type: 'profile_update',
    title: 'Profile Updated',
    description: `Updated: ${updatedFields.join(', ')}`,
    metadata: { updatedFields },
    ipAddress,
    userAgent,
  });
};

/**
 * Log login activity
 */
const logLogin = async (
  userId: string,
  organizationId: string | undefined,
  ipAddress?: string,
  userAgent?: string
): Promise<IUserActivity> => {
  return createActivity({
    userId,
    organizationId,
    type: 'login',
    title: 'Signed In',
    description: 'Successfully signed into the account',
    ipAddress,
    userAgent,
  });
};

/**
 * Log avatar update activity
 */
const logAvatarUpdate = async (
  userId: string,
  organizationId: string | undefined
): Promise<IUserActivity> => {
  return createActivity({
    userId,
    organizationId,
    type: 'avatar_updated',
    title: 'Profile Picture Updated',
    description: 'Changed profile picture',
  });
};

export default {
  createActivity,
  getRecentActivities,
  getOrganizationActivities,
  getActivityCount,
  deleteOldActivities,
  logProfileUpdate,
  logLogin,
  logAvatarUpdate,
};
