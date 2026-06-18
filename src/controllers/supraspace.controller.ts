import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import { getIO } from '../socket/supraspace.socket';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';
import { IUser } from '../models/User.model';
import { generateCrmToken } from '../middleware/crmAuth.middleware';
import { generateJaasToken, jaasRoomName, jaasConfigured, JAAS_DOMAIN } from '../services/jaas.service';
import notificationService from '../services/notification.service';

// ─── Helpers ───────────────────────────────────────────────────────────────

const idIn = (arr: any[], id: any) => (arr || []).map(String).includes(id.toString());
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  const signed = await Promise.all(conversations.map((c: any) => withFreshAvatar(c)));
  res.json(new ApiResponse(200, signed, 'Conversations fetched'));
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

  res.json(new ApiResponse(200, conversation, 'Direct conversation ready'));
});

/** POST /api/supraspace/conversations/group */
const createGroup = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { name, memberIds } = req.body;

  if (!name?.trim()) throw new ApiError(400, 'Group name is required');
  if (!Array.isArray(memberIds) || memberIds.length < 1) {
    throw new ApiError(400, 'At least one other member is required');
  }

  const uniqueMembers = [...new Set([userId.toString(), ...memberIds])];

  const conversation = await SupraSpaceConversation.create({
    type: 'group',
    name: name.trim(),
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
  const { name, addMembers, removeMembers } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (conversation.type !== 'group') throw new ApiError(400, 'Only group conversations can be updated');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const isAdmin = idIn(conversation.admins as any, userId);

  if (name !== undefined) {
    if (!isAdmin) throw new ApiError(403, 'Only admins can rename the group');
    conversation.name = (name || '').trim();
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

  // Otherwise hide the conversation only for this user
  if (!idIn(conversation.deletedFor as any, userId)) {
    conversation.deletedFor.push(userId as any);
    await conversation.save();
  }
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

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

  const filter: any = { conversationId: id, isDeleted: false };
  if (before) filter.createdAt = { $lt: new Date(before as string) };

  const messages = await SupraSpaceMessage.find(filter)
    .populate('sender', 'fullName username avatar')
    .populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } })
    .sort({ createdAt: -1 })
    .limit(parseInt(limit as string))
    .lean();

  await SupraSpaceMessage.updateMany(
    { conversationId: id, readBy: { $ne: userId } },
    { $addToSet: { readBy: userId } }
  );

  const signed = await Promise.all(messages.map((m: any) => signAttachments(m)));
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
  const messages = await SupraSpaceMessage.find({ conversationId: id, isDeleted: false, content: rx })
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
  const { content, replyTo, attachments, gif } = req.body;

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasGif = !!gif?.url;
  if (!content?.trim() && !hasAttachments && !hasGif) throw new ApiError(400, 'Message content is required');

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

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
  });

  await message.populate('sender', 'fullName username avatar');
  if (replyTo) await message.populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } });

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  conversation.deletedFor = [] as any; // bring it back for anyone who hid it
  await conversation.save();

  const messageForClient = await signAttachments(message.toObject() as any);
  emitToConversation(conversation, 'message:new', { conversationId: id, message: messageForClient });

  // ── @mention notifications (fire-and-forget) ───────────────────────────
  (async () => {
    try {
      const text = content?.trim() || '';
      if (!text) return;
      const mentionedNames = new Set<string>();
      let hasAll = false;
      const pattern = /@(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const name = m[1].toLowerCase();
        if (name === 'all') hasAll = true;
        else mentionedNames.add(name);
      }
      if (!hasAll && mentionedNames.size === 0) return;

      const memberIds = (conversation.members as any[]).map((x: any) => x.toString()).filter((x: string) => x !== userId.toString());
      const members = await CrmUser.find({ _id: { $in: memberIds } }).select('_id fullName').lean();

      const toNotify = hasAll
        ? members.map((x: any) => x._id.toString())
        : members.filter((x: any) => mentionedNames.has(x.fullName.split(' ')[0].toLowerCase())).map((x: any) => x._id.toString());

      if (toNotify.length === 0) return;

      const senderDoc = await CrmUser.findById(userId).select('fullName').lean();
      const senderName = (senderDoc as any)?.fullName || 'Someone';
      const orgId = (req.crmUser!.organizationId as any).toString();
      const preview = text.length > 100 ? text.slice(0, 100) + '…' : text;

      await Promise.allSettled(toNotify.map((memberId: string) =>
        notificationService.createNotification({
          userId: memberId,
          organizationId: orgId,
          type: 'crm_message',
          title: `${senderName} mentioned you`,
          message: `"${preview}"`,
          metadata: { conversationId: id, messageId: message._id.toString(), route: '/crm/supra-space' },
        })
      ));
    } catch { /* best-effort */ }
  })();

  res.status(201).json(new ApiResponse(201, messageForClient, 'Message sent'));
});

/** POST /api/supraspace/conversations/:id/upload  — files & voice notes */
const uploadAttachment = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { replyTo, content, duration } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');

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
  conversation.deletedFor = [] as any;
  await conversation.save();

  const messageForClient = await signAttachments(message.toObject() as any);
  emitToConversation(conversation, 'message:new', { conversationId: id, message: messageForClient });
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
    .select('fullName username avatar role')
    .sort({ fullName: 1 })
    .lean();
  res.json(new ApiResponse(200, users, 'Users fetched'));
});

/** GET /api/supraspace/active  — all team users (presence resolved live via socket) */
const getActiveUsers = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const users = await CrmUser.find({ _id: { $ne: userId }, isActive: true })
    .select('fullName username avatar role')
    .sort({ fullName: 1 })
    .lean();
  res.json(new ApiResponse(200, users, 'Team users fetched'));
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
  setTheme,
  getMessages,
  searchInConversation,
  searchMessages,
  sendMessage,
  uploadAttachment,
  reactToMessage,
  deleteMessage,
  createPoll,
  votePoll,
  createEvent,
  rsvpEvent,
  getCrmUsers,
  getActiveUsers,
  generateVideoToken,
};

export default supraSpaceController;