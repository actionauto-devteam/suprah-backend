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
 */
const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
) => {
  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Verify current password
  const isPasswordMatch = await user.isPasswordMatch(currentPassword);
  if (!isPasswordMatch) {
    throw new ApiError(401, 'Current password is incorrect');
  }

  // Validate new password
  if (newPassword.length < 8) {
    throw new ApiError(400, 'New password must be at least 8 characters long');
  }

  // Update password
  user.password = newPassword;
  await user.save();

  // Create notification
  await notificationService.createNotification({
    userId,
    type: 'password_changed',
    title: 'Password Changed',
    message: 'Your password has been successfully changed.',
    metadata: { timestamp: new Date() },
  });

  return { message: 'Password changed successfully' };
};

/**
 * Update email
 */
const updateEmail = async (
  userId: string,
  newEmail: string,
  password: string
) => {
  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // Verify password
  const isPasswordMatch = await user.isPasswordMatch(password);
  if (!isPasswordMatch) {
    throw new ApiError(401, 'Password is incorrect');
  }

  // Check if email is already taken
  const emailTaken = await User.isEmailTaken(newEmail, userId);
  if (emailTaken) {
    throw new ApiError(400, 'Email is already in use');
  }

  const oldEmail = user.email;
  user.email = newEmail;
  await user.save();

  // Create notification
  await notificationService.createNotification({
    userId,
    type: 'email_changed',
    title: 'Email Changed',
    message: `Your email has been changed from ${oldEmail} to ${newEmail}.`,
    metadata: { oldEmail, newEmail },
  });

  return user;
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