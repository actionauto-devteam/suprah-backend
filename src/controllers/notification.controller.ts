import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import Notification from '../models/Notification.model';
import { IUser } from '../models/User.model';

const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)?._id.toString();
  const { page = 1, limit = 20, isRead } = req.query;

  const query: any = { userId };
  
  // Filter by read status if provided
  if (isRead !== undefined) {
    query.isRead = isRead === 'true';
  }

  const notifications = await Notification.find(query)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .skip((Number(page) - 1) * Number(limit));

  const total = await Notification.countDocuments(query);

  res.json(new ApiResponse(200, {
    notifications,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  }, 'Notifications fetched successfully'));
});

const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)?._id.toString();

  const count = await Notification.countDocuments({
    userId,
    isRead: false,
  });

  res.json(new ApiResponse(200, { count }, 'Unread count fetched successfully'));
});

const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req.user as IUser)?._id.toString();

  const notification = await Notification.findOneAndUpdate(
    { _id: id, userId },
    { isRead: true },
    { new: true }
  );

  if (!notification) {
    return res.status(404).json(new ApiResponse(404, null, 'Notification not found'));
  }

  res.json(new ApiResponse(200, notification, 'Notification marked as read'));
});

const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)?._id.toString();

  const result = await Notification.updateMany(
    { userId, isRead: false },
    { isRead: true }
  );

  res.json(new ApiResponse(200, {
    modifiedCount: result.modifiedCount,
  }, 'All notifications marked as read'));
});

const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req.user as IUser)?._id.toString();

  const notification = await Notification.findOneAndDelete({
    _id: id,
    userId,
  });

  if (!notification) {
    return res.status(404).json(new ApiResponse(404, null, 'Notification not found'));
  }

  res.json(new ApiResponse(200, null, 'Notification deleted successfully'));
});

const deleteAllRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)?._id.toString();

  const result = await Notification.deleteMany({
    userId,
    isRead: true,
  });

  res.json(new ApiResponse(200, {
    deletedCount: result.deletedCount,
  }, 'All read notifications deleted'));
});

export default {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
};