import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import notificationService from '../services/notification.service';
import { ApiResponse } from '../utils/ApiResponse';

/**
 * Get all notifications for the authenticated user
 */
const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { limit, skip, isRead } = req.query;

  const options: any = {};
  if (limit) options.limit = parseInt(limit as string);
  if (skip) options.skip = parseInt(skip as string);
  if (isRead !== undefined) options.isRead = isRead === 'true';

  const result = await notificationService.getUserNotifications(userId, options);

  res.json(
    new ApiResponse(200, result, 'Notifications fetched successfully')
  );
});

/**
 * Get unread notification count
 */
const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const count = await notificationService.getUnreadCount(userId);

  res.json(
    new ApiResponse(200, { count }, 'Unread count fetched successfully')
  );
});

/**
 * Mark a notification as read
 */
const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { id } = req.params;

  const notification = await notificationService.markAsRead(id, userId);

  res.json(
    new ApiResponse(200, notification, 'Notification marked as read')
  );
});

/**
 * Mark all notifications as read
 */
const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;

  await notificationService.markAllAsRead(userId);

  res.json(
    new ApiResponse(200, null, 'All notifications marked as read')
  );
});

/**
 * Delete a notification
 */
const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const { id } = req.params;

  await notificationService.deleteNotification(id, userId);

  res.json(
    new ApiResponse(200, null, 'Notification deleted successfully')
  );
});

/**
 * Delete all read notifications
 */
const deleteAllRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;

  await notificationService.deleteAllRead(userId);

  res.json(
    new ApiResponse(200, null, 'All read notifications deleted')
  );
});

export default {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
};