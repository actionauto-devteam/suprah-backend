import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import profileService from '../services/profile.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

/**
 * Get user profile with extended information
 */
const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const profile = await profileService.getProfile(userId);

  res.json(
    new ApiResponse(200, profile, 'Profile fetched successfully')
  );
});

/**
 * Update user profile
 */
const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { name, avatar, theme, onlineStatus, customStatus, personalInfo } = req.body;

  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (avatar !== undefined) updateData.avatar = avatar;
  if (theme !== undefined) updateData.theme = theme;
  if (onlineStatus !== undefined) updateData.onlineStatus = onlineStatus;
  if (customStatus !== undefined) updateData.customStatus = customStatus;
  if (personalInfo !== undefined) updateData.personalInfo = personalInfo;

  const orgId = (req as any).orgId;
  const profile = await profileService.updateProfile(userId, updateData, orgId);

  res.json(
    new ApiResponse(200, profile, 'Profile updated successfully')
  );
});

/**
 * Update online status
 */
const updateOnlineStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { status, customStatus } = req.body;

  if (!status) {
    throw new ApiError(400, 'Status is required');
  }

  const validStatuses = ['online', 'away', 'busy', 'offline', 'do_not_disturb'];
  if (!validStatuses.includes(status)) {
    throw new ApiError(400, 'Invalid status value');
  }

  const user = await profileService.updateOnlineStatus(userId, status, customStatus);

  res.json(
    new ApiResponse(200, user, 'Online status updated successfully')
  );
});

/**
 * Update personal information
 */
const updatePersonalInfo = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orgId = (req as any).orgId;
  const personalInfo = req.body;

  const user = await profileService.updatePersonalInfo(userId, personalInfo, orgId);

  res.json(
    new ApiResponse(200, user, 'Personal information updated successfully')
  );
});

/**
 * Update avatar/profile picture
 */
const updateAvatar = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orgId = (req as any).orgId;
  const { avatar } = req.body;

  if (!avatar) {
    throw new ApiError(400, 'Avatar is required');
  }

  const user = await profileService.updateAvatar(userId, avatar, orgId);

  res.json(
    new ApiResponse(200, user, 'Avatar updated successfully')
  );
});

/**
 * Get recent activities
 */
const getRecentActivities = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const limit = parseInt(req.query.limit as string) || 20;

  const activities = await profileService.getRecentActivities(userId, limit);

  res.json(
    new ApiResponse(200, activities, 'Recent activities fetched successfully')
  );
});

/**
 * Change password
 */
const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    throw new ApiError(400, 'All password fields are required');
  }

  if (newPassword !== confirmPassword) {
    throw new ApiError(400, 'New password and confirm password do not match');
  }

  await profileService.changePassword(userId, currentPassword, newPassword);

  res.json(
    new ApiResponse(200, null, 'Password changed successfully')
  );
});

/**
 * Update email
 */
const updateEmail = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError(400, 'Email and password are required');
  }

  const user = await profileService.updateEmail(userId, email, password);

  res.json(
    new ApiResponse(200, user, 'Email updated successfully')
  );
});

/**
 * Update notification preferences
 */
const updateNotificationPreferences = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user._id;
    const preferences = req.body;

    const user = await profileService.updateNotificationPreferences(
      userId,
      preferences
    );

    res.json(
      new ApiResponse(
        200,
        user,
        'Notification preferences updated successfully'
      )
    );
  }
);

/**
 * Update theme
 */
const updateTheme = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { theme } = req.body;

  if (!theme || !['light', 'dark'].includes(theme)) {
    throw new ApiError(400, 'Invalid theme value');
  }

  const orgId = (req as any).orgId;
  const user = await profileService.updateTheme(userId, theme, orgId);

  res.json(
    new ApiResponse(200, user, 'Theme updated successfully')
  );
});

export default {
  getProfile,
  updateProfile,
  updateOnlineStatus,
  updatePersonalInfo,
  updateAvatar,
  getRecentActivities,
  changePassword,
  updateEmail,
  updateNotificationPreferences,
  updateTheme,
};