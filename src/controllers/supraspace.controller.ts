import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceSpace from '../models/SupraSpaceSpace.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import { getIO, isUserOnline } from '../socket/supraspace.socket';
import { resolvePresenceForCrmRoster } from '../utils/presenceBridge';
import { storageService, BucketType } from '../services/storage.service';
import { CrmPushService } from '../services/crmPush.service';
import logger from '../utils/logger';
import { IUser } from '../models/User.model';
import { generateCrmToken } from '../middleware/crmAuth.middleware';
import { generateJaasToken, jaasRoomName, jaasConfigured, JAAS_DOMAIN } from '../services/jaas.service';
import notificationService from '../services/notification.service';


const idIn = (arr: any[], id: any) => (arr || []).map(String).includes(id.toString());
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAYPULSE_REPORT_CHANNEL_NAME = 'DayPulse Reports';
const DAYPULSE_REPORT_CHANNEL_NAME_REGEX = /^DayPulse Reports$/i;
type SupraSpaceNotifType = 'all' | 'main' | 'foryou' | 'none';
type SupraSpaceNotifPref = { type: SupraSpaceNotifType; muted: boolean };
const DEFAULT_NOTIFICATION_PREF: SupraSpaceNotifPref = { type: 'all', muted: false };

function emitToConversation(conv: any, event: string, payload: any) {
  try {
    const io = getIO();
    (conv.members || []).forEach((m: any) => {
      io.to(`user:${m.toString ? m.toString() : m}`).emit(event, payload);
    });
    if (conv._id) io.to(`conv:${conv._id.toString()}`).emit(event, payload);
  } catch (err) {
    console.warn(`[SupraSpace] Socket emit failed on ${event}:`, err);
  }
}

// Push Web Push notifications to conversation members. Desktop users who are
// online already receive the realtime socket event, but mobile/PWA sockets can
// stay "online" briefly after the app is backgrounded. To keep installed mobile
// apps reliable, online recipients still get pushes on mobile-like subscriptions.
// Fire-and-forget — never lets push errors block the HTTP response.
async function pushToOfflineMembers(conv: any, senderId: string, title: string, body: string, textForMention = ''): Promise<void> {
  try {
    const recipientIds = (conv.members || [])
      .map((m: any) => (m.toString ? m.toString() : String(m)))
      .filter((id: string) => id !== senderId);

    if (!recipientIds.length) return;

    const recipients = await CrmUser.find({ _id: { $in: recipientIds } })
      .select('_id fullName username')
      .lean();

    await Promise.allSettled(recipientIds.map(async (memberId: string) => {
      const recipient = recipients.find((user: any) => user._id.toString() === memberId);
      const pref = getConversationNotificationPref(conv, memberId);
      const mentioned = recipient ? isUserMentioned(textForMention, recipient as any) : /(^|\s)@all(?=$|[\s.,!?;:)\]])/i.test(textForMention);
      if (!shouldNotifyForPreference(pref, mentioned)) return;

      const unreadCount = await SupraSpaceMessage.countDocuments({
        conversationId: conv._id,
        sender: { $ne: memberId },
        readBy: { $ne: memberId },
        isDeleted: false,
        scheduledStatus: { $ne: 'pending' },
      });
      const isOnline = isUserOnline(memberId);

      await CrmPushService.sendToUsers([memberId], {
        title,
        body: unreadCount >= 2 ? `${unreadCount} new messages` : body,
        icon: '/icon-192x192.png',
        tag: conv._id?.toString() ?? 'supraspace',
        data: { url: '/crm/supra-space' },
      }, isOnline ? { deviceHints: ['mobile', 'ios', 'android', 'iphone', 'ipad', 'pwa'] } : undefined);
    }));
  } catch (err) {
    logger.warn({ err }, '[SupraSpace] pushToOfflineMembers failed');
  }
}

function isDayPulseReportConversation(conversation: { name?: string | null }): boolean {
  return DAYPULSE_REPORT_CHANNEL_NAME_REGEX.test(conversation.name || '');
}

function getConversationNotificationPref(conv: any, userId: string): SupraSpaceNotifPref {
  const raw = conv?.notificationPrefs?.[userId];
  const type = raw?.type === 'main' || raw?.type === 'foryou' || raw?.type === 'none' ? raw.type : 'all';
  return { type, muted: !!raw?.muted };
}

function mentionBoundaryRegex(alias: string): RegExp | null {
  const normalized = alias.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  return new RegExp(`(^|\\s)@${escapeRegex(normalized)}(?=$|[\\s.,!?;:)\\]])`, 'i');
}

function mentionAliasesForName(fullName: string): string[] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const aliases = new Set<string>();
  if (parts.length) aliases.add(parts[0]);
  if (parts.length >= 2) aliases.add(`${parts[0]} ${parts[parts.length - 1]}`);
  if (fullName.trim()) aliases.add(fullName.trim());
  return [...aliases];
}

function isUserMentioned(text: string, user: { fullName?: string | null; username?: string | null }): boolean {
  if (/(^|\s)@all(?=$|[\s.,!?;:)\]])/i.test(text)) return true;
  const aliases = [
    ...(user.username ? [user.username] : []),
    ...mentionAliasesForName(user.fullName || ''),
  ];
  return aliases.some((alias) => mentionBoundaryRegex(alias)?.test(text));
}

function mentionContentQueryForUser(user: { fullName?: string | null; username?: string | null }): any[] {
  const mentionPatterns = [
    /(^|\s)@all(?=$|[\s.,!?;:)\]])/i,
    ...(user.username ? [user.username] : []),
    ...mentionAliasesForName(user.fullName || ''),
  ]
    .map((alias: string | RegExp) => (alias instanceof RegExp ? alias : mentionBoundaryRegex(alias)))
    .filter(Boolean) as RegExp[];

  return mentionPatterns.map((rx) => ({ content: rx }));
}

function shouldNotifyForPreference(pref: SupraSpaceNotifPref, isMentioned: boolean): boolean {
  if (pref.muted || pref.type === 'none') return false;
  if (pref.type === 'foryou') return isMentioned;
  return true;
}

async function notifyMentionedMembers(params: {
  text: string;
  conversation: any;
  senderId: any;
  organizationId: string;
  messageId: string;
  route?: string;
}) {
  try {
    const text = params.text.trim();
    if (!text) return;

    const hasAll = /(^|\s)@all(?=$|[\s.,!?;:)\]])/i.test(text);
    const memberIds = (params.conversation.members as any[])
      .map((x: any) => x.toString())
      .filter((x: string) => x !== params.senderId.toString());
    if (!memberIds.length) return;

    const members = await CrmUser.find({ _id: { $in: memberIds } }).select('_id fullName username').lean();
    const toNotify = hasAll
      ? members.map((x: any) => x._id.toString())
      : members
          .filter((member: any) =>
            mentionAliasesForName(member.fullName || '').some((alias) => mentionBoundaryRegex(alias)?.test(text)),
          )
          .map((x: any) => x._id.toString());

    const uniqueRecipients = [...new Set(toNotify)].filter((memberId) =>
      shouldNotifyForPreference(getConversationNotificationPref(params.conversation, memberId), true)
    );
    if (!uniqueRecipients.length) return;

    const senderDoc = await CrmUser.findById(params.senderId).select('fullName').lean();
    const senderName = (senderDoc as any)?.fullName || 'Someone';
    const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;

    await Promise.allSettled(uniqueRecipients.map((memberId: string) =>
      notificationService.createNotification({
        userId: memberId,
        organizationId: params.organizationId,
        type: 'crm_message',
        title: `${senderName} mentioned you`,
        message: `"${preview}"`,
        metadata: {
          conversationId: params.conversation._id.toString(),
          messageId: params.messageId,
          route: params.route || '/crm/supra-space',
        },
      })
    ));
  } catch {
    // Mention notifications are best-effort and should not block sending.
  }
}

async function getOrCreateDayPulseReportConversation(organizationId: string, creatorId: any) {
  const orgMembers = await CrmUser.find({ organizationId, isActive: true }).select('_id').lean();
  const memberIds = orgMembers.map((m) => m._id);
  if (!memberIds.length) throw new ApiError(400, 'No active CRM users found for this organization');

  const candidates = await SupraSpaceConversation.find({
    type: 'group',
    isActive: true,
    name: { $regex: DAYPULSE_REPORT_CHANNEL_NAME_REGEX },
    members: { $in: memberIds },
  }).sort({ createdAt: 1 });

  let canonical = candidates[0];

  if (!canonical) {
    canonical = await SupraSpaceConversation.create({
      type: 'group',
      name: DAYPULSE_REPORT_CHANNEL_NAME,
      members: memberIds,
      admins: [creatorId],
      createdBy: creatorId,
    });
  }

  canonical.name = DAYPULSE_REPORT_CHANNEL_NAME;
  canonical.members = memberIds as any;
  canonical.deletedFor = [];
  canonical.isActive = true;
  await canonical.save({ validateModifiedOnly: true });

  const duplicates = candidates.filter((conversation) => conversation._id.toString() !== canonical._id.toString());
  for (const duplicate of duplicates) {
    duplicate.isActive = false;
    duplicate.deletedAt = new Date();
    await duplicate.save({ validateModifiedOnly: true });
    emitToConversation(duplicate, 'conversation:deleted', { conversationId: duplicate._id.toString() });
  }

  return canonical;
}

async function signAttachments(message: any) {
  if (Array.isArray(message?.attachments)) {
    for (const a of message.attachments) {
      if (a.url && !a.url.startsWith('http')) {
        const signed = await storageService.getSignedUrl(a.fileKey || a.url);
        if (signed) {
          a.url = signed;
          if (a.thumbnailUrl) a.thumbnailUrl = signed;
        }
      }
    }
  }
  return message;
}

const AVATAR_SIGN_TTL = 7 * 24 * 60 * 60;

async function withFreshAvatar<T extends { avatarKey?: string | null; avatar?: string | null }>(conv: T): Promise<T> {
  if (conv?.avatarKey) {
    const signed = await storageService.getSignedUrl(conv.avatarKey, AVATAR_SIGN_TTL);
    if (signed) conv.avatar = signed;
  }
  return conv;
}

// ─── Conversations ───────────────────────────────────────────────────────────

/** GET /api/supraspace/conversations */
const getConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const mentionContentQuery = mentionContentQueryForUser(req.crmUser as any);

  // Hide deprecated auto-generated technical/orphan groups (configurable via env).
  const deprecated = (process.env.DEPRECATED_AUTO_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const conversations = await SupraSpaceConversation.find({
    members: userId,
    isActive: true,
    deletedFor: { $ne: userId },
    'metadata.type': { $nin: ['customer_concern', 'customer_call'] },
    ...(deprecated.length ? { name: { $nin: deprecated } } : {}),
  })
    .populate('members', 'fullName username avatar role')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'fullName username avatar' },
    })
    .sort({ lastMessageAt: -1 })
    .lean();

  const userIdStr = userId.toString();
  const signed = await Promise.all(conversations.map((c: any) => withFreshAvatar(c)));

  // For conversations the user has cleared, hide the old lastMessage so the
  // preview doesn't show stale content. Only null it when no new messages have
  // arrived since the clear (lastMessageAt is still <= clearedAt timestamp).
  const filtered = await Promise.all(signed.map(async (c: any) => {
    // Strip null member entries that can appear when a CrmUser is hard-deleted
    // after being added to a conversation. Keeping nulls causes the frontend to
    // crash on member._id access, triggering the "Something went wrong" error page.
    const safeConv = { ...c, members: (c.members || []).filter(Boolean) };
    const clearedAt = safeConv.clearedAt?.[userIdStr];
    if (clearedAt && safeConv.lastMessageAt && new Date(safeConv.lastMessageAt) <= new Date(clearedAt)) {
      return {
        ...safeConv,
        notificationPreference: getConversationNotificationPref(safeConv, userIdStr),
        lastMessage: null,
        lastMessageAt: null,
        unreadCount: 0,
      };
    }
    const unreadFilter: any = {
      conversationId: safeConv._id,
      sender: { $ne: userId },
      readBy: { $ne: userId },
      isDeleted: false,
      scheduledStatus: { $ne: 'pending' },
    };
    if (clearedAt) unreadFilter.createdAt = { $gt: new Date(clearedAt) };
    const unreadCount = await SupraSpaceMessage.countDocuments(unreadFilter);
    const unreadMentionCount = mentionContentQuery.length
      ? await SupraSpaceMessage.countDocuments({
          ...unreadFilter,
          $or: mentionContentQuery,
        })
      : 0;
    return {
      ...safeConv,
      notificationPreference: getConversationNotificationPref(safeConv, userIdStr),
      unreadCount,
      unreadMentionCount,
    };
  }));

  res.json(new ApiResponse(200, filtered, 'Conversations fetched'));
});

const updateConversationNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { type, muted } = req.body || {};
  const validTypes: SupraSpaceNotifType[] = ['all', 'main', 'foryou', 'none'];

  if (!validTypes.includes(type)) throw new ApiError(400, 'Invalid notification type');

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const userKey = userId.toString();
  const nextPref: SupraSpaceNotifPref = { type, muted: !!muted };
  conversation.notificationPrefs = {
    ...((conversation.notificationPrefs as any) || {}),
    [userKey]: nextPref,
  };
  conversation.markModified('notificationPrefs');
  await conversation.save({ validateModifiedOnly: true });

  try {
    getIO().to(`user:${userKey}`).emit('conversation:notification-preference', {
      conversationId: id,
      preference: nextPref,
    });
  } catch {
    // Realtime preference sync is best-effort; the REST response remains source of truth.
  }

  res.json(new ApiResponse(200, nextPref, 'Notification settings saved'));
});

/** POST /api/supraspace/conversations/direct */
const getOrCreateDirect = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { targetUserId } = req.body;

  if (!targetUserId) throw new ApiError(400, 'targetUserId is required');
  if (targetUserId === userId.toString()) throw new ApiError(400, 'Cannot DM yourself');

  let target = await CrmUser.findById(targetUserId).lean();

  if (!target) {
    const mainUser = await User.findById(targetUserId).select('email').lean();
    if (mainUser?.email) {
      target = await CrmUser.findOne({ email: mainUser.email }).lean();
    }
  }

  if (!target) throw new ApiError(404, 'User not found');

  const resolvedTargetId = target._id;

  let conversation = await SupraSpaceConversation.findOne({
    type: 'direct',
    members: { $all: [userId, resolvedTargetId], $size: 2 },
  })
    .populate('members', 'fullName username avatar role')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'fullName username avatar' },
    });

  if (!conversation) {
    conversation = await SupraSpaceConversation.create({
      type: 'direct',
      members: [userId, resolvedTargetId],
      admins: [],
      createdBy: userId,
    });
    await conversation.populate('members', 'fullName username avatar role');
  } else {
    if (idIn(conversation.deletedFor as any, userId)) {
      conversation.deletedFor = (conversation.deletedFor as any).filter(
        (m: any) => m.toString() !== userId.toString()
      );
      await conversation.save();
    }
  }

  const convObj: any = conversation.toObject();
  convObj.members = (convObj.members || []).filter(Boolean);
  const clearedAt = convObj.clearedAt?.[userId.toString()];
  if (clearedAt && convObj.lastMessageAt && new Date(convObj.lastMessageAt) <= new Date(clearedAt)) {
    convObj.lastMessage = null;
    convObj.lastMessageAt = null;
  }

  res.json(new ApiResponse(200, convObj, 'Direct conversation ready'));
});

/** POST /api/supraspace/conversations/group */
const createGroup = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { name, emoji, memberIds } = req.body;

  if (!name?.trim()) throw new ApiError(400, 'Group name is required');
  if (!Array.isArray(memberIds) || memberIds.length < 1) {
    throw new ApiError(400, 'At least one other member is required');
  }

  const uniqueMembers = [...new Set([userId.toString(), ...memberIds])];

  const conversation = await SupraSpaceConversation.create({
    type: 'group',
    name: name.trim(),
    emoji: emoji?.trim?.() || null,
    members: uniqueMembers,
    admins: [userId],
    createdBy: userId,
  });

  await conversation.populate('members', 'fullName username avatar role');
  emitToConversation(conversation, 'conversation:new', conversation);

  res.status(201).json(new ApiResponse(201, conversation, 'Group created'));
});

/** PATCH /api/supraspace/conversations/:id  — name + add/remove members */
const updateConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { name, emoji, addMembers, removeMembers } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (conversation.type !== 'group') throw new ApiError(400, 'Only group conversations can be updated');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const isAdmin = idIn(conversation.admins as any, userId) || conversation.createdBy.toString() === userId.toString();

  if (name !== undefined) {
    if (!isAdmin) throw new ApiError(403, 'Only admins can rename the group');
    conversation.name = (name || '').trim();
  }

  if (emoji !== undefined) {
    if (!isAdmin) throw new ApiError(403, 'Only admins can update the group emoji');
    conversation.emoji = (emoji || '').trim() || null;
  }

  // Any member can add new members; only admin (or self) may remove
  if (Array.isArray(addMembers)) {
    addMembers.forEach((m) => {
      if (!idIn(conversation.members as any, m)) {
        conversation.members.push(new mongoose.Types.ObjectId(m));
      }
    });
  }

  if (Array.isArray(removeMembers) && removeMembers.length) {
    const removingOnlySelf = removeMembers.length === 1 && removeMembers[0] === userId.toString();
    if (!isAdmin && !removingOnlySelf) throw new ApiError(403, 'Only admins can remove members');
    conversation.members = conversation.members.filter(
      (m) => !removeMembers.includes(m.toString())
    ) as any;
    conversation.admins = conversation.admins.filter(
      (m) => !removeMembers.includes(m.toString())
    ) as any;
  }

  await conversation.save();
  await conversation.populate('members', 'fullName username avatar role');
  await withFreshAvatar(conversation);
  emitToConversation(conversation, 'conversation:updated', conversation);

  res.json(new ApiResponse(200, conversation, 'Group updated'));
});

/** POST /api/supraspace/conversations/:id/avatar  — channel photo (multipart, field 'avatar') */
const updateAvatar = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (conversation.type !== 'group') throw new ApiError(400, 'Only channels support custom photos');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const file = (req.file as Express.Multer.File) || (req.files as Express.Multer.File[] | undefined)?.[0];
  if (!file) throw new ApiError(400, 'No image uploaded');
  if (!file.mimetype.startsWith('image/')) throw new ApiError(400, 'Avatar must be an image');

  let url: string;
  try {
    url = await storageService.upload(file, 'chat-avatars', BucketType.PRIVATE, { allowLocalFallback: false });
  } catch (err: any) {
    logger.error({ err, conversationId: id }, '[SupraSpace] Avatar upload failed');
    throw new ApiError(503, 'Avatar upload is temporarily unavailable. Please try again.');
  }

  // Clean previous avatar
  if (conversation.avatarKey) {
    await storageService.delete(conversation.avatarKey).catch(() => {});
  }

  conversation.avatarKey = storageService.getKeyFromUrl(url) || url;
  conversation.avatar = (await storageService.getSignedUrl(conversation.avatarKey, AVATAR_SIGN_TTL)) || url;
  await conversation.save();

  emitToConversation(conversation, 'conversation:updated', { _id: id, avatar: conversation.avatar });
  res.json(new ApiResponse(200, { _id: id, avatar: conversation.avatar }, 'Channel photo updated'));
});

/** DELETE /api/supraspace/conversations/:id  — delete channel (admin) or hide DM/thread (per user) */
const deleteConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const isAdmin = idIn(conversation.admins as any, userId) || conversation.createdBy.toString() === userId.toString();

  if (conversation.type === 'group' && isAdmin) {
    // Permanently delete the channel for everyone
    conversation.isActive = false;
    conversation.deletedAt = new Date();
    await conversation.save();
    await SupraSpaceMessage.updateMany(
      { conversationId: id },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
    emitToConversation(conversation, 'conversation:deleted', { conversationId: id });
    return res.json(new ApiResponse(200, { conversationId: id, permanent: true }, 'Channel deleted'));
  }

  // Hide the conversation for this user and record the clear timestamp so that
  // getMessages filters out all messages sent before this moment.
  // Even if the user re-opens the same DM later (getOrCreateDirect removes them
  // from deletedFor), messages sent before this timestamp remain hidden for them.
  const userIdStr = userId.toString();
  await SupraSpaceConversation.updateOne(
    { _id: id },
    {
      $addToSet: { deletedFor: userId },
      $set: { [`clearedAt.${userIdStr}`]: new Date() },
    }
  );
  res.json(new ApiResponse(200, { conversationId: id, permanent: false }, 'Conversation removed'));
});

/** POST /api/supraspace/conversations/:id/archive  { archived: boolean } */
const archiveConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const archived = req.body?.archived !== false;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  if (archived) {
    if (!idIn(conversation.archivedBy as any, userId)) conversation.archivedBy.push(userId as any);
  } else {
    conversation.archivedBy = conversation.archivedBy.filter((m) => m.toString() !== userId.toString()) as any;
  }
  await conversation.save();
  res.json(new ApiResponse(200, { conversationId: id, archived }, archived ? 'Conversation archived' : 'Conversation unarchived'));
});

/** POST /api/supraspace/conversations/:id/pin  { pinned: boolean } */
const pinConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const pinned = req.body?.pinned !== false;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  if (pinned) {
    if (!idIn(conversation.pinnedBy as any, userId)) conversation.pinnedBy.push(userId as any);
  } else {
    conversation.pinnedBy = conversation.pinnedBy.filter((m) => m.toString() !== userId.toString()) as any;
  }
  await conversation.save();
  res.json(new ApiResponse(200, { conversationId: id, pinned }, pinned ? 'Conversation pinned' : 'Conversation unpinned'));
});

/** PATCH /api/supraspace/conversations/:id/theme  { theme } */
const setTheme = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { theme } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  conversation.theme = {
    accent: theme?.accent ?? null,
    bubble: theme?.bubble ?? null,
    wallpaper: theme?.wallpaper ?? null,
    emoji: theme?.emoji ?? null,
  };
  await conversation.save();
  emitToConversation(conversation, 'conversation:theme', { conversationId: id, theme: conversation.theme });
  res.json(new ApiResponse(200, { conversationId: id, theme: conversation.theme }, 'Theme updated'));
});

// ─── Messages ─────────────────────────────────────────────────────────────────

/** GET /api/supraspace/conversations/:id/messages */
const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { before, limit = '40' } = req.query;

  // Use lean() so clearedAt comes back as a plain JS object — no Mongoose Mixed
  // type accessor wrapping that can silently swallow bracket-notation key access.
  const conversation = await SupraSpaceConversation.findById(id).lean();
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const filter: any = { conversationId: id, isDeleted: false, scheduledStatus: { $ne: 'pending' } };
  const createdAtFilter: any = {};
  if (before) createdAtFilter.$lt = new Date(before as string);
  const rawClearedAt = (conversation as any).clearedAt?.[userId.toString()];
  if (rawClearedAt) {
    // Stored as BSON Date; ensure it's a JS Date regardless of driver version
    createdAtFilter.$gt = rawClearedAt instanceof Date ? rawClearedAt : new Date(rawClearedAt);
  }
  if (Object.keys(createdAtFilter).length > 0) filter.createdAt = createdAtFilter;

  const messages = await SupraSpaceMessage.find(filter)
    .populate('sender', 'fullName username avatar')
    .populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } })
    .sort({ createdAt: -1 })
    .limit(parseInt(limit as string))
    .lean();

  // Fire-and-forget: mark messages read without blocking the response.
  // Awaiting this on large channels (e.g. 27 members, hundreds of messages)
  // can time out or throw, which would return a 500 and leave the client
  // showing an empty chat even though messages exist.
  SupraSpaceMessage.updateMany(
    { conversationId: id, readBy: { $ne: userId } },
    { $addToSet: { readBy: userId } }
  ).catch(() => {});

  // Customer messages use a synthetic sentinel ObjectId for `sender` that doesn't
  // correspond to any CrmUser document, so populate() returns null for them.
  // Replace null senders using the customer info stored in message metadata.
  const fallbackSender = (m: any) => ({
    _id: m.metadata?.customerUserId || 'unknown',
    fullName: m.metadata?.customerName || 'Customer',
    username: m.metadata?.customerUserId || 'customer',
    avatar: m.metadata?.customerAvatar || null,
    isCustomer: true,
  });
  const safeMsgs = messages.map((m: any) => ({
    ...m,
    sender: m.sender || fallbackSender(m),
    replyTo: m.replyTo ? { ...m.replyTo, sender: m.replyTo.sender || fallbackSender(m.replyTo) } : m.replyTo,
  }));

  const signed = await Promise.all(safeMsgs.map((m: any) => signAttachments(m)));
  res.json(new ApiResponse(200, signed.reverse(), 'Messages fetched'));
});

/** GET /api/supraspace/conversations/:id/search?q=  — search inside a conversation */
const searchInConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const q = (req.query.q as string) || '';

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  if (!q.trim()) return res.json(new ApiResponse(200, [], 'No query'));

  const rx = new RegExp(escapeRegex(q.trim()), 'i');
  const messages = await SupraSpaceMessage.find({ conversationId: id, isDeleted: false, scheduledStatus: { $ne: 'pending' }, content: rx })
    .populate('sender', 'fullName username avatar')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.json(new ApiResponse(200, messages, 'Search results'));
});

/** GET /api/supraspace/search?q=  — global message search across the user's conversations */
const searchMessages = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const q = (req.query.q as string) || '';
  if (!q.trim() || q.trim().length < 2) return res.json(new ApiResponse(200, [], 'No query'));

  const convs = await SupraSpaceConversation.find({
    members: userId,
    isActive: true,
    deletedFor: { $ne: userId },
    'metadata.type': { $nin: ['customer_concern', 'customer_call'] },
  }).select('_id').lean();
  const convIds = convs.map((c: any) => c._id);

  const rx = new RegExp(escapeRegex(q.trim()), 'i');
  const messages = await SupraSpaceMessage.find({
    conversationId: { $in: convIds },
    isDeleted: false,
    scheduledStatus: { $ne: 'pending' },
    content: rx,
  })
    .populate('sender', 'fullName username avatar')
    .populate('conversationId', 'name type members avatar')
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  res.json(new ApiResponse(200, messages, 'Search results'));
});

/** POST /api/supraspace/conversations/:id/messages  — text / gif / pre-uploaded attachments */
const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { content, replyTo, attachments, gif, scheduledAt } = req.body;

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasGif = !!gif?.url;
  if (!content?.trim() && !hasAttachments && !hasGif) throw new ApiError(400, 'Message content is required');

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  if (isDayPulseReportConversation(conversation)) {
    throw new ApiError(403, 'DayPulse Reports is read-only. Reports are posted automatically from DayPulse.');
  }

  const scheduledDate = scheduledAt ? new Date(scheduledAt) : null;
  const isScheduled = !!scheduledDate && !Number.isNaN(scheduledDate.getTime()) && scheduledDate.getTime() > Date.now() + 30_000;
  if (scheduledAt && !isScheduled) throw new ApiError(400, 'Schedule time must be at least 30 seconds in the future');
  if (isScheduled && hasAttachments) throw new ApiError(400, 'Scheduled send currently supports text and GIF messages only');

  let msgType: any = 'text';
  if (hasGif) msgType = 'gif';
  else if (hasAttachments) {
    const hasImage = attachments.some((a: any) => a.mimeType?.startsWith('image/'));
    msgType = hasImage && attachments.length === 1 ? 'image' : 'file';
  }

  const message = await SupraSpaceMessage.create({
    conversationId: id,
    sender: userId,
    content: content?.trim() || '',
    type: msgType,
    attachments: hasAttachments ? attachments : [],
    gif: hasGif ? gif : null,
    replyTo: replyTo || null,
    readBy: [userId],
    scheduledAt: isScheduled ? scheduledDate : null,
    scheduledStatus: isScheduled ? 'pending' : null,
    sentAt: isScheduled ? null : new Date(),
  });

  await message.populate('sender', 'fullName username avatar');
  if (replyTo) await message.populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } });

  if (isScheduled) {
    return res.status(202).json(new ApiResponse(202, message.toObject(), 'Message scheduled'));
  }

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;

  // Capture members who had this conversation hidden before we clear deletedFor.
  // We emit conversation:new only to them so their sidebar updates immediately.
  // We clear ALL deletedFor entries (not just the sender) so the backend DB is
  // consistent with what we tell the frontend — otherwise the next getConversations
  // call would re-hide the conversation for resurrected members, causing the
  // disappear-then-reappear flicker the user reported.
  const resurrectedFor = (conversation.deletedFor as any[])
    .map(String)
    .filter(id => id !== userId.toString());
  conversation.deletedFor = [];
  await conversation.save();

  const messageForClient = await signAttachments(message.toObject() as any);
  emitToConversation(conversation, 'message:new', { conversationId: id, message: messageForClient });

  // Web Push to offline members (those whose socket has disconnected, e.g. mobile background)
  const senderName = (req.crmUser as any)?.fullName || 'Someone';
  const pushBody = content?.trim()
    ? content.trim().slice(0, 120)
    : hasGif ? 'Sent a GIF' : 'Sent an attachment';
  const convName = (conversation as any).name;
  const pushTitle = convName ? convName : senderName;
  const pushBodyFinal = convName ? `${senderName}: ${pushBody}` : pushBody;
  pushToOfflineMembers(conversation, userId.toString(), pushTitle, pushBodyFinal, content?.trim() || '');

  // Notify previously-hidden members so their sidebar shows the conversation
  // without waiting for a manual refresh or page reload.
  if (resurrectedFor.length > 0) {
    try {
      const io = getIO();
      const convForClient = await SupraSpaceConversation.findById(id)
        .populate('members', 'fullName username avatar role')
        .lean();
      if (convForClient) {
        resurrectedFor.forEach(memberId => {
          io.to(`user:${memberId}`).emit('conversation:new', convForClient);
        });
      }
    } catch { /* non-critical */ }
  }

  // ── @mention notifications (fire-and-forget) ───────────────────────────
  notifyMentionedMembers({
    text: content?.trim() || '',
    conversation,
    senderId: userId,
    organizationId: (req.crmUser!.organizationId as any).toString(),
    messageId: message._id.toString(),
  });

  res.status(201).json(new ApiResponse(201, messageForClient, 'Message sent'));
});

/** POST /api/supraspace/conversations/:id/upload  — files & voice notes */
const postDayPulseReport = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const orgId = (req.crmUser!.organizationId as any)?.toString();
  const { content, attachments } = req.body;

  if (!orgId) throw new ApiError(403, 'Your account is not linked to an organization');
  if (!content?.trim()) throw new ApiError(400, 'Report content is required');

  const conversation = await getOrCreateDayPulseReportConversation(orgId, userId);
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  const hasImage = normalizedAttachments.some((a: any) => a.mimeType?.startsWith('image/'));
  const msgType: any = normalizedAttachments.length
    ? hasImage && normalizedAttachments.length === 1 ? 'image' : 'file'
    : 'system';

  const message = await SupraSpaceMessage.create({
    conversationId: conversation._id,
    sender: userId,
    content: content.trim(),
    type: msgType,
    attachments: normalizedAttachments,
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');
  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  conversation.deletedFor = [];
  await conversation.save({ validateModifiedOnly: true });

  const messageForClient = await signAttachments(message.toObject() as any);
  emitToConversation(conversation, 'conversation:updated', {
    _id: conversation._id.toString(),
    name: DAYPULSE_REPORT_CHANNEL_NAME,
  });
  emitToConversation(conversation, 'message:new', {
    conversationId: conversation._id.toString(),
    message: messageForClient,
  });

  res.status(201).json(new ApiResponse(201, { conversationId: conversation._id, message: messageForClient }, 'DayPulse report posted'));
});

const uploadAttachment = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { replyTo, content, duration } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  if (isDayPulseReportConversation(conversation)) {
    throw new ApiError(403, 'DayPulse Reports is read-only. Reports are posted automatically from DayPulse.');
  }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) throw new ApiError(400, 'No files uploaded');

  const attachments: any[] = [];
  let hasImage = false;
  let hasAudio = false;

  for (const file of files) {
    const isImage = file.mimetype.startsWith('image/');
    const isAudio = file.mimetype.startsWith('audio/');
    if (isImage) hasImage = true;
    if (isAudio) hasAudio = true;

    let fileUrl: string;
    try {
      fileUrl = await storageService.upload(file, 'chat-attachments', BucketType.PRIVATE, { allowLocalFallback: false });
    } catch (err: any) {
      logger.error({ err, conversationId: id, fileName: file.originalname }, '[SupraSpace] Attachment upload failed');
      throw new ApiError(503, 'Attachment upload is temporarily unavailable. Please try again.');
    }
    const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;

    attachments.push({
      url: fileUrl,
      fileKey,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      thumbnailUrl: isImage ? fileUrl : undefined,
      duration: isAudio && duration ? Number(duration) : undefined,
    });
  }

  const type = hasAudio && files.length === 1 ? 'voice'
    : hasImage && files.length === 1 ? 'image'
    : 'file';

  const message = await SupraSpaceMessage.create({
    conversationId: id,
    sender: userId,
    content: content?.trim() || '',
    type,
    attachments,
    replyTo: replyTo || null,
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');
  if (replyTo) await message.populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } });

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;

  const resurrectedFor = (conversation.deletedFor as any[])
    .map(String)
    .filter(id => id !== userId.toString());
  conversation.deletedFor = [];
  await conversation.save();

  const messageForClient = await signAttachments(message.toObject() as any);
  emitToConversation(conversation, 'message:new', { conversationId: id, message: messageForClient });

  const fileSenderName = (req.crmUser as any)?.fullName || 'Someone';
  const convNameFile = (conversation as any).name;
  pushToOfflineMembers(
    conversation,
    userId.toString(),
    convNameFile ?? fileSenderName,
    convNameFile ? `${fileSenderName}: Sent a file` : 'Sent a file',
    content?.trim() || ''
  );

  if (resurrectedFor.length > 0) {
    try {
      const io = getIO();
      const convForClient = await SupraSpaceConversation.findById(id)
        .populate('members', 'fullName username avatar role')
        .lean();
      if (convForClient) {
        resurrectedFor.forEach(memberId => {
          io.to(`user:${memberId}`).emit('conversation:new', convForClient);
        });
      }
    } catch { /* non-critical */ }
  }

  notifyMentionedMembers({
    text: content?.trim() || '',
    conversation,
    senderId: userId,
    organizationId: (req.crmUser!.organizationId as any).toString(),
    messageId: message._id.toString(),
  });

  res.status(201).json(new ApiResponse(201, messageForClient, 'File sent'));
});

/** POST /api/supraspace/messages/:messageId/react  { emoji }  — toggle reaction */
const reactToMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;
  const { emoji } = req.body;
  if (!emoji) throw new ApiError(400, 'emoji is required');

  const message = await SupraSpaceMessage.findById(messageId);
  if (!message || message.isDeleted) throw new ApiError(404, 'Message not found');

  const conversation = await SupraSpaceConversation.findById(message.conversationId).lean();
  if (!conversation || !idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const existing = message.reactions.find((r) => r.emoji === emoji);
  if (existing) {
    if (idIn(existing.users as any, userId)) {
      existing.users = existing.users.filter((u) => u.toString() !== userId.toString()) as any;
      if (existing.users.length === 0) message.reactions = message.reactions.filter((r) => r.emoji !== emoji) as any;
    } else {
      existing.users.push(userId as any);
    }
  } else {
    message.reactions.push({ emoji, users: [userId] } as any);
  }
  await message.save();

  const payload = { conversationId: message.conversationId.toString(), messageId, reactions: message.reactions };
  emitToConversation(conversation, 'message:reaction', payload);
  res.json(new ApiResponse(200, payload, 'Reaction updated'));
});

/** DELETE /api/supraspace/messages/:messageId  — soft delete (sender only) */
const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;

  const message = await SupraSpaceMessage.findById(messageId).lean();
  if (!message) throw new ApiError(404, 'Message not found');
  if (message.sender.toString() !== userId.toString()) throw new ApiError(403, 'You can only delete your own messages');
  if (message.isDeleted) return res.json(new ApiResponse(200, null, 'Message already deleted'));

  await SupraSpaceMessage.findByIdAndUpdate(
    messageId,
    { $set: { isDeleted: true, deletedAt: new Date(), content: '', attachments: [], gif: null, poll: null, event: null } },
    { runValidators: false }
  );

  if (message.attachments && message.attachments.length > 0) {
    for (const a of message.attachments) {
      if (a.fileKey) await storageService.delete(a.fileKey).catch((e) => console.warn('[SupraSpace] R2 delete:', e.message));
    }
  }

  const conversation = await SupraSpaceConversation.findById(message.conversationId).lean();
  if (conversation) {
    emitToConversation(conversation, 'message:deleted', {
      conversationId: message.conversationId.toString(),
      messageId,
    });
  }
  res.json(new ApiResponse(200, null, 'Message deleted'));
});

/** PATCH /api/supraspace/messages/:messageId  { content }  — edit own message text/caption */
const editMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;
  const { content } = req.body;

  const message = await SupraSpaceMessage.findById(messageId);
  if (!message || message.isDeleted) throw new ApiError(404, 'Message not found');
  if (message.sender.toString() !== userId.toString()) throw new ApiError(403, 'You can only edit your own messages');
  if (message.type === 'voice' || message.type === 'poll' || message.type === 'event') {
    throw new ApiError(400, 'This message type cannot be edited');
  }
  if (!content?.trim() && message.attachments.length === 0) throw new ApiError(400, 'Content is required');

  message.content = content?.trim() || '';
  message.isEdited = true;
  await message.save();

  const conversation = await SupraSpaceConversation.findById(message.conversationId).lean();
  if (conversation) {
    emitToConversation(conversation, 'message:edited', {
      conversationId: message.conversationId.toString(),
      messageId,
      content: message.content,
    });
  }

  res.json(new ApiResponse(200, { content: message.content, isEdited: true }, 'Message edited'));
});

/** PATCH /api/supraspace/messages/:messageId/attachments — replace/remove attachments and update caption */
const replaceMessageAttachments = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  const files = (req.files || []) as Express.Multer.File[];

  const message = await SupraSpaceMessage.findById(messageId);
  if (!message || message.isDeleted) throw new ApiError(404, 'Message not found');
  if (message.sender.toString() !== userId.toString()) throw new ApiError(403, 'You can only edit your own messages');
  if (message.type === 'voice' || message.type === 'poll' || message.type === 'event' || message.type === 'gif') {
    throw new ApiError(400, 'This message type cannot have its attachments replaced');
  }
  if (!content && files.length === 0) throw new ApiError(400, 'A message or attachment is required');

  const oldAttachments = [...(message.attachments || [])];
  const replacements: any[] = [];
  try {
    for (const file of files) {
      const fileUrl = await storageService.upload(file, 'chat-attachments', BucketType.PRIVATE, { allowLocalFallback: false });
      replacements.push({
        url: fileUrl,
        fileKey: storageService.getKeyFromUrl(fileUrl) || fileUrl,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        thumbnailUrl: file.mimetype.startsWith('image/') ? fileUrl : undefined,
      });
    }
  } catch (err) {
    await Promise.all(replacements.map(a => storageService.delete(a.fileKey).catch(() => undefined)));
    logger.error({ err, messageId }, '[SupraSpace] Attachment replacement failed');
    throw new ApiError(503, 'Attachment replacement is temporarily unavailable. Please try again.');
  }

  message.content = content;
  message.attachments = replacements;
  message.type = replacements.some(a => a.mimeType.startsWith('image/')) && replacements.length === 1
    ? 'image'
    : replacements.length > 0 ? 'file' : 'text';
  message.isEdited = true;

  try {
    await message.save();
  } catch (err) {
    await Promise.all(replacements.map(a => storageService.delete(a.fileKey).catch(() => undefined)));
    throw err;
  }

  await Promise.all(oldAttachments.map(a => {
    const key = a.fileKey || a.url;
    return key ? storageService.delete(key).catch(e => logger.warn({ err: e, messageId }, '[SupraSpace] Old attachment cleanup failed')) : Promise.resolve();
  }));

  const conversation = await SupraSpaceConversation.findById(message.conversationId).lean();
  const messageForClient = await signAttachments(message.toObject() as any);
  if (conversation) {
    emitToConversation(conversation, 'message:edited', {
      conversationId: message.conversationId.toString(),
      messageId,
      content: message.content,
      attachments: messageForClient.attachments,
      type: message.type,
    });
  }

  res.json(new ApiResponse(200, messageForClient, files.length ? 'Attachment replaced' : 'Attachment removed'));
});

// ─── Polls ───────────────────────────────────────────────────────────────────

/** POST /api/supraspace/conversations/:id/poll  { question, options[], allowMultiple } */
const createPoll = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { question, options, allowMultiple } = req.body;

  if (!question?.trim()) throw new ApiError(400, 'Poll question is required');
  const opts = (options || []).map((t: string) => t?.trim()).filter(Boolean);
  if (opts.length < 2) throw new ApiError(400, 'At least two options are required');

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  if (isDayPulseReportConversation(conversation)) {
    throw new ApiError(403, 'DayPulse Reports is read-only. Reports are posted automatically from DayPulse.');
  }

  const message = await SupraSpaceMessage.create({
    conversationId: id,
    sender: userId,
    type: 'poll',
    content: '',
    poll: {
      question: question.trim(),
      allowMultiple: !!allowMultiple,
      closed: false,
      options: opts.map((text: string, i: number) => ({ id: `opt_${i}_${Date.now()}`, text, votes: [] })),
    },
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');
  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const messageForClient = message.toObject();
  emitToConversation(conversation, 'message:new', { conversationId: id, message: messageForClient });
  res.status(201).json(new ApiResponse(201, messageForClient, 'Poll created'));
});

/** POST /api/supraspace/messages/:messageId/poll/vote  { optionId } */
const votePoll = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;
  const { optionId } = req.body;

  const message = await SupraSpaceMessage.findById(messageId);
  if (!message || !message.poll) throw new ApiError(404, 'Poll not found');
  if (message.poll.closed) throw new ApiError(400, 'This poll is closed');

  const conversation = await SupraSpaceConversation.findById(message.conversationId).lean();
  if (!conversation || !idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const uid = userId.toString();
  message.poll.options = message.poll.options.map((o) => {
    const hasVoted = idIn(o.votes as any, userId);
    if (o.id === optionId) {
      o.votes = hasVoted ? (o.votes.filter((v) => v.toString() !== uid) as any) : ([...o.votes, userId] as any);
    } else if (!message.poll!.allowMultiple) {
      o.votes = o.votes.filter((v) => v.toString() !== uid) as any;
    }
    return o;
  }) as any;
  message.markModified('poll');
  await message.save();

  const payload = { conversationId: message.conversationId.toString(), messageId, poll: message.poll };
  emitToConversation(conversation, 'message:poll', payload);
  res.json(new ApiResponse(200, payload, 'Vote recorded'));
});

// ─── Events ──────────────────────────────────────────────────────────────────

/** POST /api/supraspace/conversations/:id/event */
const createEvent = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { title, description, location, startTime, endTime } = req.body;

  if (!title?.trim()) throw new ApiError(400, 'Event title is required');
  if (!startTime) throw new ApiError(400, 'Event start time is required');

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  if (isDayPulseReportConversation(conversation)) {
    throw new ApiError(403, 'DayPulse Reports is read-only. Reports are posted automatically from DayPulse.');
  }

  const message = await SupraSpaceMessage.create({
    conversationId: id,
    sender: userId,
    type: 'event',
    content: '',
    event: {
      title: title.trim(),
      description: description?.trim() || '',
      location: location?.trim() || '',
      startTime: new Date(startTime),
      endTime: endTime ? new Date(endTime) : null,
      going: [userId],
      maybe: [],
      declined: [],
    },
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');
  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const messageForClient = message.toObject();
  emitToConversation(conversation, 'message:new', { conversationId: id, message: messageForClient });
  res.status(201).json(new ApiResponse(201, messageForClient, 'Event created'));
});

/** POST /api/supraspace/messages/:messageId/event/rsvp  { response: going|maybe|declined } */
const rsvpEvent = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;
  const { response } = req.body;
  if (!['going', 'maybe', 'declined'].includes(response)) throw new ApiError(400, 'Invalid RSVP response');

  const message = await SupraSpaceMessage.findById(messageId);
  if (!message || !message.event) throw new ApiError(404, 'Event not found');

  const conversation = await SupraSpaceConversation.findById(message.conversationId).lean();
  if (!conversation || !idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const uid = userId.toString();
  (['going', 'maybe', 'declined'] as const).forEach((key) => {
    message.event![key] = (message.event![key] as any).filter((u: any) => u.toString() !== uid);
  });
  (message.event as any)[response].push(userId);
  message.markModified('event');
  await message.save();

  const payload = { conversationId: message.conversationId.toString(), messageId, event: message.event };
  emitToConversation(conversation, 'message:event', payload);
  res.json(new ApiResponse(200, payload, 'RSVP recorded'));
});

// ─── Users / Presence ──────────────────────────────────────────────────────

/** GET /api/supraspace/users */
const getCrmUsers = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const users = await CrmUser.find({ _id: { $ne: userId }, isActive: true })
    .select('fullName username avatar role email')
    .sort({ fullName: 1 })
    .lean();
  const presenceMap = await resolvePresenceForCrmRoster(users);
  const withPresence = users.map((u: any) => ({ ...u, presence: presenceMap.get(u._id.toString()) }));
  res.json(new ApiResponse(200, withPresence, 'Users fetched'));
});

/** GET /api/supraspace/active  — all team users, real onlineStatus resolved via presenceBridge */
const getActiveUsers = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const users = await CrmUser.find({ _id: { $ne: userId }, isActive: true })
    .select('fullName username avatar role email')
    .sort({ fullName: 1 })
    .lean();
  const presenceMap = await resolvePresenceForCrmRoster(users);
  const withPresence = users.map((u: any) => ({ ...u, presence: presenceMap.get(u._id.toString()) }));
  res.json(new ApiResponse(200, withPresence, 'Team users fetched'));
});

// ─── Video Conferencing ────────────────────────────────────────────────────

const generateVideoToken = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const user = req.crmUser!;
  const roomName = `supraspace-${id}`;

  // No JaaS configured → return room only (fallback path, identity via userInfo).
  if (!jaasConfigured()) {
    return res.json(new ApiResponse(200, { token: undefined, roomName, domain: JAAS_DOMAIN }, 'JaaS not configured'));
  }

  const token = generateJaasToken({
    user: {
      id: userId.toString(),
      name: user.fullName,
      email: user.username,
      avatar: user.avatar,
      moderator: true,
    },
  });
  res.json(new ApiResponse(200, { token, roomName: jaasRoomName(roomName), domain: JAAS_DOMAIN }, 'Video token generated'));
});

const getSessionToken = asyncHandler(async (req: Request, res: Response) => {
  const mainUser = req.user as IUser;
  const crmUser = await CrmUser.findOne({ email: mainUser.email }).select('_id').lean();
  if (!crmUser) throw new ApiError(404, 'No CRM account linked to this user. Please contact your administrator.');

  // Routed through generateCrmToken so the token carries type:'crm' and uses the
  // same secret chain as the SupraSpace socket. (Fixes "Invalid CRM token type".)
  const token = generateCrmToken(crmUser._id.toString(), '30d');

  res.json(new ApiResponse(200, { token }, 'Session token issued'));
});

// ─── Spaces ───────────────────────────────────────────────────────────────────

/** GET /api/supraspace/spaces */
const getSpaces = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;

  const spaces = await SupraSpaceSpace.find({ members: userId, isActive: true })
    .populate('members', 'fullName username avatar role')
    .sort({ createdAt: 1 })
    .lean();

  res.json(new ApiResponse(200, spaces, 'Spaces fetched'));
});

/** POST /api/supraspace/spaces  { name, emoji?, memberIds[] } */
const createSpace = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { name, emoji, memberIds = [] } = req.body;

  if (!name?.trim()) throw new ApiError(400, 'Space name is required');

  const uniqueMembers = [...new Set([userId.toString(), ...memberIds])];

  const space = await SupraSpaceSpace.create({
    name: name.trim(),
    emoji: emoji || null,
    members: uniqueMembers,
    admins: [userId],
    createdBy: userId,
  });

  await space.populate('members', 'fullName username avatar role');

  const io = getIO();
  uniqueMembers.forEach((mId: string) => {
    io.to(`user:${mId}`).emit('space:new', { space });
  });

  res.json(new ApiResponse(201, { space }, 'Space created'));
});

/** PATCH /api/supraspace/spaces/:id  { name?, emoji?, addMembers?, removeMembers? } */
const updateSpace = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { name, emoji, addMembers, removeMembers } = req.body;

  const space = await SupraSpaceSpace.findById(id);
  if (!space) throw new ApiError(404, 'Space not found');
  if (!idIn(space.admins as any, userId)) throw new ApiError(403, 'Only admins can update this space');

  if (name?.trim()) space.name = name.trim();
  if (emoji !== undefined) space.emoji = emoji;

  if (Array.isArray(addMembers) && addMembers.length) {
    addMembers.forEach((mId: string) => {
      if (!idIn(space.members as any, mId)) space.members.push(mId as any);
    });
  }
  if (Array.isArray(removeMembers) && removeMembers.length) {
    space.members = space.members.filter(m => !removeMembers.includes(m.toString())) as any;
  }

  await space.save();
  await space.populate('members', 'fullName username avatar role');

  const io = getIO();
  (space.members as any[]).forEach((m: any) => {
    io.to(`user:${m._id?.toString() || m.toString()}`).emit('space:updated', { space });
  });

  res.json(new ApiResponse(200, space, 'Space updated'));
});

/** DELETE /api/supraspace/spaces/:id */
const deleteSpace = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;

  const space = await SupraSpaceSpace.findById(id);
  if (!space) throw new ApiError(404, 'Space not found');
  if (!idIn(space.admins as any, userId)) throw new ApiError(403, 'Only admins can delete this space');

  // Unlink all conversations from this space (move them back to Channels)
  await SupraSpaceConversation.updateMany({ spaceId: id }, { $set: { spaceId: null } });

  space.isActive = false;
  await space.save();

  const io = getIO();
  (space.members as any[]).forEach((m: any) => {
    io.to(`user:${m.toString ? m.toString() : m}`).emit('space:deleted', { spaceId: id });
  });

  res.json(new ApiResponse(200, { spaceId: id }, 'Space deleted'));
});

/** PATCH /api/supraspace/conversations/:id/space  { spaceId: string | null } */
const moveConversationToSpace = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { spaceId } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  if (conversation.type !== 'group') throw new ApiError(400, 'Only group conversations can be moved to a space');

  if (spaceId) {
    const space = await SupraSpaceSpace.findById(spaceId);
    if (!space) throw new ApiError(404, 'Space not found');
    if (!idIn(space.members as any, userId)) throw new ApiError(403, 'You are not a member of that space');
    (conversation as any).spaceId = space._id;
  } else {
    (conversation as any).spaceId = null;
  }

  await conversation.save();

  emitToConversation(conversation, 'conversation:moved', { conversationId: id, spaceId: spaceId || null });

  res.json(new ApiResponse(200, { conversationId: id, spaceId: spaceId || null }, 'Conversation moved'));
});

/** GET /api/supraspace/conversations/:id/messages/:msgId/voice — proxy-streams private audio */
const streamVoiceMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id, msgId } = req.params;

  const conversation = await SupraSpaceConversation.findById(id).lean();
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member');

  const message = await SupraSpaceMessage.findOne({ _id: msgId, conversationId: id }).lean();
  if (!message || message.type !== 'voice') throw new ApiError(404, 'Voice message not found');

  const att = (message.attachments || []).find((a: any) => a.mimeType?.startsWith('audio/'));
  if (!att) throw new ApiError(404, 'No audio attachment');

  const key: string = att.fileKey || att.url;

  // Full http URL → redirect to it (presigned URL or public URL)
  if (key.startsWith('http')) {
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.redirect(302, key);
  }

  // R2 key or local path → generate fresh signed URL and redirect
  const signed = await storageService.getSignedUrl(key, 3600);
  if (signed) {
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.redirect(302, signed);
  }

  // Last resort: stream directly from local storage
  const result = await storageService.streamPrivateFile(key);
  if (!result) throw new ApiError(404, 'Audio file not found in storage');

  res.setHeader('Content-Type', att.mimeType || 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');
  result.stream.pipe(res);
});

const supraSpaceController = {
  getSessionToken,
  getConversations,
  getOrCreateDirect,
  createGroup,
  updateConversation,
  updateAvatar,
  deleteConversation,
  archiveConversation,
  pinConversation,
  updateConversationNotifications,
  setTheme,
  getMessages,
  searchInConversation,
  searchMessages,
  sendMessage,
  postDayPulseReport,
  uploadAttachment,
  reactToMessage,
  editMessage,
  replaceMessageAttachments,
  deleteMessage,
  createPoll,
  votePoll,
  createEvent,
  rsvpEvent,
  getCrmUsers,
  getActiveUsers,
  generateVideoToken,
  getSpaces,
  createSpace,
  updateSpace,
  deleteSpace,
  moveConversationToSpace,
  streamVoiceMessage,
};

export default supraSpaceController;
