import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import profileService from '../services/profile.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

/**
 * Get user profile
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
  const { name, avatar, theme } = req.body;

  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (avatar !== undefined) updateData.avatar = avatar;
  if (theme !== undefined) updateData.theme = theme;

  const orgId = (req as any).orgId;
  const profile = await profileService.updateProfile(userId, updateData, orgId);

  res.json(
    new ApiResponse(200, profile, 'Profile updated successfully')
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
  changePassword,
  updateEmail,
  updateNotificationPreferences,
  updateTheme,
};