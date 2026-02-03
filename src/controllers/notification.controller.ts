import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import notificationService from '../services/notification.service';
import { ApiResponse } from '../utils/ApiResponse';

/**
 * Get all notifications for the current user
 */
const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const { limit, skip, isRead } = req.query;

  const result = await notificationService.getUserNotifications(
    userId.toString(),
    {
      limit: limit ? parseInt(limit as string) : undefined,
      skip: skip ? parseInt(skip as string) : undefined,
      isRead: isRead !== undefined ? isRead === 'true' : undefined,
    }
  );

  res.json(
    new ApiResponse(200, result, 'Notifications fetched successfully')
  );
});

/**
 * Get unread notification count
 */
const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;

  const count = await notificationService.getUnreadCount(userId.toString());

  res.json(
    new ApiResponse(200, { unreadCount: count }, 'Unread count fetched successfully')
  );
});

/**
 * Mark a notification as read
 */
const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const notificationId = req.params.id;

  const notification = await notificationService.markAsRead(
    notificationId,
    userId.toString()
  );

  res.json(
    new ApiResponse(200, notification, 'Notification marked as read')
  );
});

/**
 * Mark all notifications as read
 */
const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;

  const result = await notificationService.markAllAsRead(userId.toString());

  res.json(
    new ApiResponse(200, result, 'All notifications marked as read')
  );
});

/**
 * Delete a notification
 */
const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;
  const notificationId = req.params.id;

  await notificationService.deleteNotification(notificationId, userId.toString());

  res.json(
    new ApiResponse(200, null, 'Notification deleted successfully')
  );
});

/**
 * Delete all read notifications
 */
const deleteAllRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id || (req as any).user._id;

  const result = await notificationService.deleteAllRead(userId.toString());

  res.json(
    new ApiResponse(200, result, 'All read notifications deleted')
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