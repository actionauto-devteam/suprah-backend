import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import notificationService from '../services/notification.service';
import CrmUser from '../models/CrmUser.model';
import { NOTIFICATION_CATEGORIES } from '../models/Notification.model';

const VALID_PREFERENCE_KEYS = new Set<string>([...NOTIFICATION_CATEGORIES, 'mutedTypes', 'prioritySenders']);
const ARRAY_PREFERENCE_KEYS = new Set(['mutedTypes', 'prioritySenders']);

// CRM-identity-scoped mirror of notification.controller.ts. Reuses the same
// underlying notification.service.ts functions (they're already polymorphic
// on userId) — only the identity source (req.crmUser instead of req.user)
// and the preferences read/write target (CrmUser instead of User) differ.
//a

const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const orgId = req.orgId as string;
  const { limit, skip, isRead, type } = req.query;
  // ?type=crm_message or ?type=crm_message,crm_task_assigned — SupraSpace's
  // own Notifications tab uses this to scope the feed to its own events
  // instead of the whole org-wide bell.
  const types = typeof type === 'string' && type.length
    ? type.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;

  const result = await notificationService.getUserNotifications(
    crmUser._id.toString(),
    orgId,
    {
      limit: limit ? parseInt(limit as string) : undefined,
      skip: skip ? parseInt(skip as string) : undefined,
      isRead: isRead !== undefined ? isRead === 'true' : undefined,
      userRole: crmUser.role,
      types,
    },
  );

  res.json(new ApiResponse(200, result, 'CRM notifications fetched successfully'));
});

const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const orgId = req.orgId as string;

  const count = await notificationService.getUnreadCount(crmUser._id.toString(), orgId, crmUser.role);

  res.json(new ApiResponse(200, { unreadCount: count }, 'Unread count fetched successfully'));
});

const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const orgId = req.orgId as string;
  const notificationId = req.params.id;

  const notification = await notificationService.markAsRead(notificationId, orgId, crmUser._id.toString());

  res.json(new ApiResponse(200, notification, 'Notification marked as read'));
});

const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const orgId = req.orgId as string;

  const result = await notificationService.markAllAsRead(crmUser._id.toString(), orgId);

  res.json(new ApiResponse(200, result, 'All notifications marked as read'));
});

const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const orgId = req.orgId as string;
  const notificationId = req.params.id;

  await notificationService.deleteNotification(notificationId, orgId, crmUser._id.toString());

  res.json(new ApiResponse(200, null, 'Notification deleted successfully'));
});

const deleteAllRead = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const orgId = req.orgId as string;

  const result = await notificationService.deleteAllRead(crmUser._id.toString(), orgId);

  res.json(new ApiResponse(200, result, 'All read notifications deleted'));
});

const getPreferences = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;

  // req.crmUser may be a synthetic (non-persisted) object for CRM-fallback
  // sessions that have no real CrmUser account — fetch fresh so preferences
  // always reflect a real, persisted document when one exists.
  const doc = await CrmUser.findById(crmUser._id).select('notificationPreferences role');
  if (!doc) {
    throw new ApiError(404, 'No CRM account found for this session — preferences are unavailable.');
  }

  res.json(new ApiResponse(200, { preferences: doc.notificationPreferences, role: doc.role }, 'CRM notification preferences fetched'));
});

const updatePreferences = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const updates = req.body as Record<string, boolean | string[]>;

  const updateData: Record<string, boolean | string[]> = {};
  Object.keys(updates).forEach((key) => {
    if (!VALID_PREFERENCE_KEYS.has(key)) return;
    const value = updates[key];
    if (ARRAY_PREFERENCE_KEYS.has(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return;
    } else if (typeof value !== 'boolean') {
      return;
    }
    updateData[`notificationPreferences.${key}`] = value;
  });

  const doc = await CrmUser.findByIdAndUpdate(
    crmUser._id,
    { $set: updateData },
    { new: true, runValidators: true },
  ).select('notificationPreferences');

  if (!doc) {
    throw new ApiError(404, 'No CRM account found for this session — preferences are unavailable.');
  }

  res.json(new ApiResponse(200, doc.notificationPreferences, 'CRM notification preferences updated'));
});

export default {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
  getPreferences,
  updatePreferences,
};
