import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import notificationService from "../services/notification.service";
import { ApiResponse } from "../utils/ApiResponse";

const resolveNotificationOrgId = (req: Request): string => {
  const user = (req as any).user;
  return req.orgId || user?.organizationId?.toString?.() || "global";
};

/**
 * Get all notifications for the current user
 */
const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const userRole = (req as any).user.role;  // NEW: Get user's role
  const orgId = resolveNotificationOrgId(req);
  const { limit, skip, isRead } = req.query;

  const result = await notificationService.getUserNotifications(
    userId.toString(),
    orgId,
    {
      limit: limit ? parseInt(limit as string) : undefined,
      skip: skip ? parseInt(skip as string) : undefined,
      isRead: isRead !== undefined ? isRead === "true" : undefined,
      userRole,  // NEW: Pass role for broadcast filtering
    },
  );

  res.json(new ApiResponse(200, result, "Notifications fetched successfully"));
});

/**
 * Get unread notification count
 */
const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const orgId = resolveNotificationOrgId(req);

  const count = await notificationService.getUnreadCount(
    userId.toString(),
    orgId,
  );

  res.json(
    new ApiResponse(
      200,
      { unreadCount: count },
      "Unread count fetched successfully",
    ),
  );
});

/**
 * Mark a notification as read
 */
const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const orgId = resolveNotificationOrgId(req);
  const notificationId = req.params.id;

  const notification = await notificationService.markAsRead(
    notificationId,
    orgId,
    userId.toString(),
  );

  res.json(new ApiResponse(200, notification, "Notification marked as read"));
});

/**
 * Mark all notifications as read
 */
const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const orgId = resolveNotificationOrgId(req);

  const result = await notificationService.markAllAsRead(
    userId.toString(),
    orgId,
  );

  res.json(new ApiResponse(200, result, "All notifications marked as read"));
});

/**
 * Delete a notification
 */
const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const orgId = resolveNotificationOrgId(req);
  const notificationId = req.params.id;

  await notificationService.deleteNotification(
    notificationId,
    orgId,
    userId.toString(),
  );

  res.json(new ApiResponse(200, null, "Notification deleted successfully"));
});

/**
 * Delete all read notifications
 */
const deleteAllRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const orgId = resolveNotificationOrgId(req);

  const result = await notificationService.deleteAllRead(
    userId.toString(),
    orgId,
  );

  res.json(new ApiResponse(200, result, "All read notifications deleted"));
});

/**
 * Broadcast notification to users with specific roles
 * Requires admin/super_admin role
 */
const broadcastNotification = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const orgId = resolveNotificationOrgId(req);
  
  // Only admins and super_admins can broadcast
  if (!['admin', 'super_admin'].includes(user.role)) {
    return res.status(403).json(new ApiResponse(403, null, 'Only administrators can broadcast notifications'));
  }

  const { roleTargets, type, title, message, metadata } = req.body;

  if (!roleTargets || !Array.isArray(roleTargets) || roleTargets.length === 0) {
    return res.status(400).json(new ApiResponse(400, null, 'roleTargets array is required'));
  }

  if (!type || !title || !message) {
    return res.status(400).json(new ApiResponse(400, null, 'type, title, and message are required'));
  }

  const result = await notificationService.broadcastNotification({
    organizationId: orgId,
    roleTargets,
    type,
    title,
    message,
    metadata,
  });

  res.json(new ApiResponse(200, result, `Notification broadcasted to ${roleTargets.join(', ')}`));
});

/**
 * Create a test notification for the current user
 * Used for testing the notification system
 */
const createTestNotification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const orgId = resolveNotificationOrgId(req);
  const { type, title, message } = req.body;

  if (!type || !title || !message) {
    return res.status(400).json(new ApiResponse(400, null, 'type, title, and message are required'));
  }

  const result = await notificationService.createNotification({
    userId: userId.toString(),
    organizationId: orgId,
    type,
    title,
    message,
    metadata: {},
  });

  res.json(new ApiResponse(200, result, 'Test notification created successfully'));
});

export default {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
  broadcastNotification,
  createTestNotification,
};
