import User, { OnlineStatus, IPersonalInfo } from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import bcrypt from 'bcryptjs';
import config from '../config';
import notificationService from './notification.service';
import activityService from './activity.service';

/**
 * Get user profile with extended information
 */
const getProfile = async (userId: string) => {
  const user = await User.findById(userId).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Get recent activities
  const recentActivities = await activityService.getRecentActivities(userId, 10);

  // Calculate account stats
  const Quote = (await import('../models/Quote.model')).default;
  const Shipment = (await import('../models/Shipment.model')).default;
  const Appointment = (await import('../models/Appointment.model')).default;

  const [totalQuotes, totalShipments, totalAppointments] = await Promise.all([
    Quote.countDocuments({ userId }).catch(() => 0),
    Shipment.countDocuments({ userId }).catch(() => 0),
    Appointment.countDocuments({ userId }).catch(() => 0),
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
    totalShipments,
    totalAppointments,
  };

  // Build Google Calendar status
  const googleCalendar = {
    connected: user.googleCalendar?.connected || false,
    connectedAt: user.googleCalendar?.connectedAt,
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
 * Update avatar/profile picture
 */
const updateAvatar = async (userId: string, avatar: string, orgId?: string) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { avatar, lastActive: new Date() } },
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
 * Change password
 * @deprecated Handled by Clerk
 */
const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
) => {
  throw new ApiError(400, "Password management is now handled by Clerk. Please use the User Profile to change your password.");
};

/**
 * Update email
 * @deprecated Handled by Clerk
 */
const updateEmail = async (
  userId: string,
  newEmail: string,
  password: string
) => {
  throw new ApiError(400, "Email management is now handled by Clerk.");
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
    shipmentCreated: boolean;
    shipmentUpdated: boolean;
    shipmentDeleted: boolean;
    passwordChanged: boolean;
    emailChanged: boolean;
    profileUpdated: boolean;
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
  changePassword,
  updateEmail,
  updateNotificationPreferences,
  updateTheme,
  getRecentActivities,
};