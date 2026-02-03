import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import bcrypt from 'bcryptjs';
import config from '../config';
import notificationService from './notification.service';

/**
 * Get user profile
 */
const getProfile = async (userId: string) => {
  const user = await User.findById(userId).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return user;
};

/**
 * Update user profile
 */
const updateProfile = async (userId: string, updateData: {
  name?: string;
  avatar?: string;
  theme?: 'light' | 'dark';
}) => {
  const user = await User.findByIdAndUpdate(
    userId,
    updateData,
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Create notification
  await notificationService.createNotification({
    userId,
    type: 'profile_updated',
    title: 'Profile Updated',
    message: 'Your profile information has been successfully updated.',
    metadata: { updatedFields: Object.keys(updateData) },
  });

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
  const updateData: any = {};

  Object.keys(preferences).forEach((key) => {
    updateData[`notificationPreferences.${key}`] = preferences[key as keyof typeof preferences];
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
const updateTheme = async (userId: string, theme: 'light' | 'dark') => {
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

export default {
  getProfile,
  updateProfile,
  changePassword,
  updateEmail,
  updateNotificationPreferences,
  updateTheme,
};