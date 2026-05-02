import User, { OnlineStatus, IPersonalInfo } from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import bcrypt from 'bcryptjs';
import config from '../config';
import notificationService from './notification.service';
import activityService from './activity.service';
import { storageService } from './storage.service';
import OrgLeadConfig from '../models/OrgLeadConfig.model';

/**
 * Update avatar/profile picture
 * Uploads to Cloudflare R2 and updates DB. Deletes old avatar if it exists.
 */
const updateAvatar = async (userId: string, file: Express.Multer.File, orgId?: string) => {
  const existingUser = await User.findById(userId).select('avatar');
  if (!existingUser) {
    throw new ApiError(404, 'User not found');
  }

  // Upload new avatar to R2
  const avatarUrl = await storageService.upload(file, 'avatars');

  // Delete old avatar (StorageService handles both R2 URLs and legacy local paths)
  if (existingUser.avatar) {
    await storageService.delete(existingUser.avatar);
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { avatar: avatarUrl, lastActive: new Date() } },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Log activity
  await activityService.logAvatarUpdate(userId, orgId);

  return user;
};
const getProfile = async (userId: string) => {
  const user = await User.findById(userId).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Get recent activities
  const recentActivities = await activityService.getRecentActivities(userId, 10);

  // Calculate account stats
  const Quote = (await import('../models/Quote.model')).default;
  const Load = (await import('../models/Load.model')).default;
  const Appointment = (await import('../models/Appointment.model')).default;

  const orgId = user.organizationId?.toString();

  const [totalQuotes, totalLoads, totalAppointments] = await Promise.all([
    Quote.countDocuments({ userId, organizationId: orgId }).catch(() => 0),
    Load.countDocuments({ createdBy: userId, organizationId: orgId }).catch(() => 0),
    Appointment.countDocuments({ userId, organizationId: orgId }).catch(() => 0),
  ]);

  // Build security status
  const securityStatus = {
    emailVerified: user.emailVerified,
    hasPassword: !!user.password,
    twoFactorEnabled: false, // For future implementation
    lastPasswordChange: user.lastPasswordChange,
    lastLogin: user.lastActive,
  };

  // Build account status
  const accountStatus = {
    isActive: user.isActive,
    isVerified: user.emailVerified,
    isPremium: user.subscription?.plan !== 'free',
    accountType: user.subscription?.plan === 'enterprise' ? 'enterprise' :
      user.subscription?.plan === 'professional' ? 'premium' : 'standard',
    lastActive: user.lastActive,
    memberSince: user.createdAt,
    totalQuotes,
    totalLoads,
    totalAppointments,
  };

  // Build Google Calendar status from Organization config
  const orgConfig = orgId ? await OrgLeadConfig.findOne({ organizationId: orgId }) : null;
  const googleCalendar = {
    connected: orgConfig?.calendarConnected || false,
    connectedAt: orgConfig?.updatedAt, // Using updatedAt as proxy for connection time
  };

  return {
    ...user.toObject(),
    securityStatus,
    accountStatus,
    googleCalendar,
    recentActivities,
  };
};

/**
 * Update user profile
 */
const updateProfile = async (userId: string, updateData: {
  name?: string;
  avatar?: string;
  theme?: 'light' | 'dark';
  onlineStatus?: OnlineStatus;
  customStatus?: string;
  personalInfo?: Partial<IPersonalInfo>;
}, orgId?: string) => {
  const updateFields: Record<string, unknown> = {};
  const updatedFieldNames: string[] = [];

  if (updateData.name !== undefined) {
    updateFields.name = updateData.name;
    updatedFieldNames.push('name');
  }
  if (updateData.avatar !== undefined) {
    updateFields.avatar = updateData.avatar;
    updatedFieldNames.push('avatar');
  }
  if (updateData.theme !== undefined) {
    updateFields.theme = updateData.theme;
    updatedFieldNames.push('theme');
  }
  if (updateData.onlineStatus !== undefined) {
    updateFields.onlineStatus = updateData.onlineStatus;
    updatedFieldNames.push('onlineStatus');
  }
  if (updateData.customStatus !== undefined) {
    updateFields.customStatus = updateData.customStatus;
    updatedFieldNames.push('customStatus');
  }

  // Handle personal info updates
  if (updateData.personalInfo) {
    for (const [key, value] of Object.entries(updateData.personalInfo)) {
      if (value !== undefined) {
        updateFields[`personalInfo.${key}`] = value;
        updatedFieldNames.push(`personalInfo.${key}`);
      }
    }
  }

  // Update lastActive timestamp
  updateFields.lastActive = new Date();

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updateFields },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Log activity
  if (updatedFieldNames.length > 0) {
    await activityService.logProfileUpdate(userId, orgId, updatedFieldNames);
  }

  // Create notification
  if (orgId && updatedFieldNames.length > 0) {
    await notificationService.createNotification({
      userId,
      organizationId: orgId,
      type: 'profile_updated',
      title: 'Profile Updated',
      message: 'Your profile information has been successfully updated.',
      metadata: { updatedFields: updatedFieldNames },
    });
  }

  return user;
};

/**
 * Update online status
 */
const updateOnlineStatus = async (userId: string, status: OnlineStatus, customStatus?: string) => {
  const updateData: Record<string, unknown> = {
    onlineStatus: status,
    lastActive: new Date(),
  };

  if (customStatus !== undefined) {
    updateData.customStatus = customStatus;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return user;
};

/**
 * Update personal information
 */
const updatePersonalInfo = async (userId: string, personalInfo: Partial<IPersonalInfo>, orgId?: string) => {
  const updateFields: Record<string, unknown> = {};
  const updatedFieldNames: string[] = [];

  for (const [key, value] of Object.entries(personalInfo)) {
    if (value !== undefined) {
      updateFields[`personalInfo.${key}`] = value;
      updatedFieldNames.push(key);
    }
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updateFields },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Log activity
  if (updatedFieldNames.length > 0) {
    await activityService.logProfileUpdate(userId, orgId, updatedFieldNames);
  }

  return user;
};

/**
 * Remove avatar/profile picture
 * Deletes from R2 or local and sets avatar to null.
 */
const removeAvatar = async (userId: string, orgId?: string) => {
  const existingUser = await User.findById(userId).select('avatar');
  if (!existingUser) {
    throw new ApiError(404, 'User not found');
  }

  // Delete from R2 or legacy local
  if (existingUser.avatar) {
    await storageService.delete(existingUser.avatar);
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { avatar: null, lastActive: new Date() } },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Log activity
  await activityService.logAvatarUpdate(userId, orgId);

  return user;
};

/**
 * Get driver-specific stats (deliveries, on-time rate, etc.)
 */
const getDriverStats = async (userId: string) => {
  const Load = (await import('../models/Load.model')).default;

  // Drivers are global, but we scope stats to the current requesting organization if applicable
  // If we want global stats, we'd omit organizationId, but for multi-tenancy, orgs should see what the driver did for THEM.
  // Note: This function might need an orgId parameter passed from the controller.
  // For now, consistent with other services, we'll look for or require it.

   // Total deliveries assigned to this driver
  const totalAssigned = await Load.countDocuments({ assignedDriverId: userId }).catch(() => 0);

  // Completed deliveries
  const deliveriesCompleted = await Load.countDocuments({
    assignedDriverId: userId,
    status: 'Delivered'
  }).catch(() => 0);

  // Active deliveries (in transit)
  const activeDeliveries = await Load.countDocuments({
    assignedDriverId: userId,
    status: { $in: ['Assigned', 'Accepted', 'Picked Up', 'In-Transit'] }
  }).catch(() => 0);

  // Calculate on-time rate from delivered shipments
  let onTimeRate = 0;
  if (deliveriesCompleted > 0) {
    const onTimeCount = await Load.countDocuments({
      assignedDriverId: userId,
      status: 'Delivered',
      $expr: {
        $or: [
          { $eq: ['$dates.delivery', null] }, 
          { $lte: ['$deliveredAt', '$dates.delivery'] },
        ],
      },
    }).catch(() => deliveriesCompleted);
    onTimeRate = Math.round((onTimeCount / deliveriesCompleted) * 100) ;
  }

  return {
    deliveriesCompleted,
    activeDeliveries,
    totalAssigned,
    onTimeRate,
    // Rating is a placeholder — we don't have a rating system yet
    rating: 0,
    totalMiles: 0, // Would require tracking data we don't have yet
  };
};

/**
 * Change password
 */
const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
) => {
  throw new ApiError(400, "Password management is handled through security settings and OTP verification.");
};

/**
 * Update email
 */
const updateEmail = async (
  userId: string,
  newEmail: string,
  password: string
) => {
  throw new ApiError(400, "Email changes must be verified through the native security workflow.");
};

/**
 * Update notification preferences
 */
const updateNotificationPreferences = async (
  userId: string,
  preferences: Partial<{
    quoteCreated: boolean;
    quoteUpdated: boolean;
    quoteDeleted: boolean;
    loadCreated: boolean;
    loadUpdated: boolean;
    loadDeleted: boolean;
    passwordChanged: boolean;
    emailChanged: boolean;
    profileUpdated: boolean;
    loginAlerts: boolean;
    appointmentCreated: boolean;
    appointmentUpdated: boolean;
    appointmentCancelled: boolean;
    driverRequests: boolean;
    crmActivity: boolean;
  }>
) => {
  const updateData: Record<string, boolean> = {};

  Object.keys(preferences).forEach((key) => {
    updateData[`notificationPreferences.${key}`] = preferences[key as keyof typeof preferences]!;
  });

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return user;
};

/**
 * Update theme
 */
const updateTheme = async (userId: string, theme: 'light' | 'dark', orgId?: string) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { theme },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return user;
};

/**
 * Get recent activities for a user
 */
const getRecentActivities = async (userId: string, limit = 20) => {
  return activityService.getRecentActivities(userId, limit);
};

export default {
  getProfile,
  updateProfile,
  updateOnlineStatus,
  updatePersonalInfo,
  updateAvatar,
  removeAvatar,
  changePassword,
  updateEmail,
  updateNotificationPreferences,
  updateTheme,
  getRecentActivities,
  getDriverStats,
};