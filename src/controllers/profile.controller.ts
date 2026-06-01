import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import profileService from '../services/profile.service';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification } from '../utils/safeNotification';
import User from '../models/User.model';
import PresenceEvent from '../models/PresenceEvent.model';
import { emitToOrg } from '../utils/socketEmitter';

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
const PRESENCE_LOG_STATUSES = new Set(['offline', 'away', 'busy', 'do_not_disturb']);
const PRESENCE_DESCS: Record<string, (name: string) => string> = {
  online:           (n) => `${n} is back Online`,
  offline:          (n) => `${n} went Offline`,
  away:             (n) => `${n} is Away`,
  busy:             (n) => `${n} set status to Busy`,
  do_not_disturb:   (n) => `${n} set Do Not Disturb`,
};

const updateOnlineStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orgId = (req as any).orgId as string | undefined;
  const { status, customStatus, expiresIn } = req.body;

  if (!status) throw new ApiError(400, 'Status is required');

  const validStatuses = ['online', 'idle', 'away', 'busy', 'offline', 'do_not_disturb'];
  if (!validStatuses.includes(status)) throw new ApiError(400, 'Invalid status value');

  const needsPrev = status === 'online';
  const currentUser = (PRESENCE_LOG_STATUSES.has(status) || needsPrev)
    ? await User.findById(userId).select('name avatar onlineStatus').lean()
    : null;

  const prevStatus = currentUser?.onlineStatus;

  const statusExpiresAt = expiresIn && Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
    ? new Date(Date.now() + Number(expiresIn) * 60_000)
    : null;

  const user = await profileService.updateOnlineStatus(userId, status, customStatus, statusExpiresAt);

  if (orgId) {
    emitToOrg(orgId, 'presence_update', {
      userId: userId.toString(),
      onlineStatus: status,
      customStatus: customStatus ?? null,
      lastActive: new Date().toISOString(),
      statusExpiresAt: statusExpiresAt?.toISOString() ?? null,
    });

    const shouldLog =
      PRESENCE_LOG_STATUSES.has(status) ||
      (status === 'online' && prevStatus && !['online', 'idle'].includes(prevStatus));

    if (shouldLog && currentUser) {
      const descFn = PRESENCE_DESCS[status];
      const event = await PresenceEvent.create({
        organizationId: orgId,
        userId,
        userName: currentUser.name,
        userAvatar: currentUser.avatar,
        type: status,
        description: descFn ? descFn(currentUser.name) : `${currentUser.name} → ${status}`,
      });
      emitToOrg(orgId, 'activity:new', event);
    }
  }

  res.json(new ApiResponse(200, user, 'Online status updated successfully'));
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
 * Update avatar/profile picture (file upload)
 */
const updateAvatar = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orgId = (req as any).orgId;
  const file = (req as any).file as Express.Multer.File | undefined;

  if (!file) {
    throw new ApiError(400, 'Avatar image file is required');
  }

  const user = await profileService.updateAvatar(userId, file, orgId);

  res.json(
    new ApiResponse(200, user, 'Avatar updated successfully')
  );
});

/**
 * Remove avatar/profile picture
 */
const removeAvatar = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orgId = (req as any).orgId;

  const user = await profileService.removeAvatar(userId, orgId);

  res.json(
    new ApiResponse(200, user, 'Avatar removed successfully')
  );
});

/**
 * Get driver-specific stats
 */
const getDriverStats = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;

  const stats = await profileService.getDriverStats(userId);

  res.json(
    new ApiResponse(200, stats, 'Driver stats fetched successfully')
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

  const u = (req as any).user;
  safeCreateNotification({ userId: u._id.toString(), organizationId: u.organizationId?.toString() || '', type: 'password_changed', title: 'Password Changed', message: 'Your password was changed successfully. If this wasn\'t you, contact support immediately.' });

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

  const u = (req as any).user;
  safeCreateNotification({ userId: u._id.toString(), organizationId: u.organizationId?.toString() || '', type: 'email_changed', title: 'Email Updated', message: `Your email has been changed to ${email}.` });

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

const MANUAL_STATUSES_SET = new Set(['away', 'busy', 'do_not_disturb']);

const heartbeat = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orgId = (req as any).orgId as string | undefined;

  const current = await User.findById(userId)
    .select('onlineStatus customStatus statusExpiresAt name avatar')
    .lean();

  const now = new Date();
  const updateData: any = { lastActive: now };
  let statusExpired = false;

  if (current?.statusExpiresAt && current.statusExpiresAt < now) {
    updateData.onlineStatus = 'online';
    updateData.customStatus = '';
    updateData.statusExpiresAt = null;
    statusExpired = true;
  } else if (current?.onlineStatus === 'offline') {
    updateData.onlineStatus = 'online';
  }

  const updated = await User.findByIdAndUpdate(userId, updateData, { new: true })
    .select('onlineStatus customStatus lastActive').lean();

  if (orgId && updated) {
    emitToOrg(orgId, 'presence_update', {
      userId: userId.toString(),
      onlineStatus: updated.onlineStatus,
      customStatus: updated.customStatus ?? null,
      lastActive: updated.lastActive,
    });

    if (statusExpired && current) {
      const event = await PresenceEvent.create({
        organizationId: orgId,
        userId,
        userName: current.name,
        userAvatar: current.avatar,
        type: 'online',
        description: `${current.name} status cleared (expired)`,
      });
      emitToOrg(orgId, 'activity:new', event);
    }
  }

  res.json(new ApiResponse(200, { onlineStatus: updated?.onlineStatus ?? 'online' }, 'ok'));
});

export default {
  getProfile,
  updateProfile,
  updateOnlineStatus,
  updatePersonalInfo,
  updateAvatar,
  removeAvatar,
  getDriverStats,
  getRecentActivities,
  changePassword,
  updateEmail,
  updateNotificationPreferences,
  updateTheme,
  heartbeat,
};