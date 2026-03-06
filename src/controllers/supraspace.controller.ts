import path from 'path';
import fs from 'fs';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import CrmUser from '../models/CrmUser.model';
import { getIO } from '../socket/supraspace.socket';

// ─── Local upload helper ──────────────────────────────────────────────────────
// Files are saved to  src/uploads/supraspace/  and served statically.
// Make sure your server has:
//   app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'supraspace');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function saveFileToDisk(buffer: Buffer, originalName: string): string {
  ensureUploadDir();
  const safeName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const filePath = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(filePath, buffer);
  return safeName; // return just the filename; URL is built in the controller
}

function buildFileUrl(req: Request, filename: string): string {
  const backendUrl =
    process.env.BACKEND_URL ||
    `${req.protocol}://${req.get('host')}`;
  return `${backendUrl}/uploads/supraspace/${filename}`;
}

// ─── Conversations ────────────────────────────────────────────────────────────

/**
 * GET /api/supraspace/conversations
 */
const getConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;

  const conversations = await SupraSpaceConversation.find({
    members: userId,
    isActive: true,
  })
    .populate('members', 'fullName username avatar role')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'fullName username avatar' },
    })
    .sort({ lastMessageAt: -1 })
    .lean();

  res.json(new ApiResponse(200, conversations, 'Conversations fetched'));
});

/**
 * POST /api/supraspace/conversations/direct
 * Get or create a DM between two users
 */
const getOrCreateDirect = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { targetUserId } = req.body;

  if (!targetUserId) throw new ApiError(400, 'targetUserId is required');
  if (targetUserId === userId.toString()) throw new ApiError(400, 'Cannot DM yourself');

  const target = await CrmUser.findById(targetUserId);
  if (!target) throw new ApiError(404, 'User not found');

  // Check if DM already exists
  let conversation = await SupraSpaceConversation.findOne({
    type: 'direct',
    members: { $all: [userId, targetUserId], $size: 2 },
  })
    .populate('members', 'fullName username avatar role')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'fullName username avatar' },
    });

  if (!conversation) {
    conversation = await SupraSpaceConversation.create({
      type: 'direct',
      members: [userId, targetUserId],
      admins: [],
      createdBy: userId,
    });
    await conversation.populate('members', 'fullName username avatar role');
  }

  res.json(new ApiResponse(200, conversation, 'Direct conversation ready'));
});

/**
 * POST /api/supraspace/conversations/group
 * Create a new group conversation
 */
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

  try {
    const io = getIO();
    uniqueMembers.forEach((memberId) => {
      io.to(`user:${memberId}`).emit('conversation:new', conversation);
    });
  } catch (socketErr) {
    console.warn('[SupraSpace] Socket emit failed on group create:', socketErr);
  }

  res.status(201).json(new ApiResponse(201, conversation, 'Group created'));
});

/**
 * PATCH /api/supraspace/conversations/:id
 * Update group name / members (admin only)
 */
const updateConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { name, addMembers, removeMembers } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (conversation.type !== 'group') throw new ApiError(400, 'Only group conversations can be updated');
  if (!conversation.admins.map(String).includes(userId.toString())) {
    throw new ApiError(403, 'Only admins can update the group');
  }

  if (name) conversation.name = name.trim();

  if (Array.isArray(addMembers)) {
    addMembers.forEach((m) => {
      if (!conversation.members.map(String).includes(m)) {
        conversation.members.push(new mongoose.Types.ObjectId(m));
      }
    });
  }

  if (Array.isArray(removeMembers)) {
    conversation.members = conversation.members.filter(
      (m) => !removeMembers.includes(m.toString())
    ) as any;
  }

  await conversation.save();
  await conversation.populate('members', 'fullName username avatar role');

  res.json(new ApiResponse(200, conversation, 'Group updated'));
});

// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * GET /api/supraspace/conversations/:id/messages
 * Cursor-based pagination (newest first, reversed for display)
 */
const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { before, limit = '40' } = req.query;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!conversation.members.map(String).includes(userId.toString())) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const filter: any = { conversationId: id, isDeleted: false };
  if (before) {
    filter.createdAt = { $lt: new Date(before as string) };
  }

  const messages = await SupraSpaceMessage.find(filter)
    .populate('sender', 'fullName username avatar')
    .populate({
      path: 'replyTo',
      populate: { path: 'sender', select: 'fullName username avatar' },
    })
    .sort({ createdAt: -1 })
    .limit(parseInt(limit as string))
    .lean();

  // Mark as read
  await SupraSpaceMessage.updateMany(
    { conversationId: id, readBy: { $ne: userId } },
    { $addToSet: { readBy: userId } }
  );

  res.json(new ApiResponse(200, messages.reverse(), 'Messages fetched'));
});

/**
 * POST /api/supraspace/conversations/:id/messages
 * Send a plain text message (with optional replyTo)
 */
const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { content, replyTo } = req.body;

  if (!content?.trim()) throw new ApiError(400, 'Message content is required');

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!conversation.members.map(String).includes(userId.toString())) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const message = await SupraSpaceMessage.create({
    conversationId: id,
    sender: userId,
    content: content.trim(),
    type: 'text',
    replyTo: replyTo || null,
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');
  if (replyTo) {
    await message.populate({
      path: 'replyTo',
      populate: { path: 'sender', select: 'fullName username avatar' },
    });
  }

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  try {
    const io = getIO();
    // Emit to personal user rooms (catches users not currently in the conv room)
    // AND to the conv room (catches users actively viewing the conversation)
    conversation.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('message:new', { conversationId: id, message });
    });
    io.to(`conv:${id}`).emit('message:new', { conversationId: id, message });
  } catch (socketErr) {
    console.warn('[SupraSpace] Socket emit failed on send:', socketErr);
  }

  res.status(201).json(new ApiResponse(201, message, 'Message sent'));
});

/**
 * POST /api/supraspace/conversations/:id/upload
 * Save files to src/uploads/supraspace/ and send as a message
 */
const uploadAttachment = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { replyTo, content } = req.body;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!conversation.members.map(String).includes(userId.toString())) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) throw new ApiError(400, 'No files uploaded');

  const attachments = [];
  let hasImage = false;

  for (const file of files) {
    const isImage = file.mimetype.startsWith('image/');
    if (isImage) hasImage = true;

    // Save to disk
    const savedFilename = saveFileToDisk(file.buffer, file.originalname);
    const fileUrl = buildFileUrl(req, savedFilename);

    attachments.push({
      url: fileUrl,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      thumbnailUrl: isImage ? fileUrl : undefined,
    });
  }

  const message = await SupraSpaceMessage.create({
    conversationId: id,
    sender: userId,
    content: content?.trim() || '',
    type: hasImage && files.length === 1 ? 'image' : 'file',
    attachments,
    replyTo: replyTo || null,
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  try {
    const io = getIO();
    conversation.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('message:new', { conversationId: id, message });
    });
    io.to(`conv:${id}`).emit('message:new', { conversationId: id, message });
  } catch (socketErr) {
    console.warn('[SupraSpace] Socket emit failed on upload:', socketErr);
  }

  res.status(201).json(new ApiResponse(201, message, 'File sent'));
});

/**
 * DELETE /api/supraspace/messages/:messageId
 * Soft-delete — sender only.
 * Uses findByIdAndUpdate to avoid Mongoose subdocument validation
 * errors that occur when assigning [] to an array of subdocs via .save().
 */
const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { messageId } = req.params;

  // Fetch lean copy first to verify ownership without loading full doc
  const message = await SupraSpaceMessage.findById(messageId).lean();
  if (!message) throw new ApiError(404, 'Message not found');
  if (message.sender.toString() !== userId.toString()) {
    throw new ApiError(403, 'You can only delete your own messages');
  }
  if (message.isDeleted) {
    return res.json(new ApiResponse(200, null, 'Message already deleted'));
  }

  // Use $set + runValidators:false to bypass subdocument array validation
  await SupraSpaceMessage.findByIdAndUpdate(
    messageId,
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        content: '',
        attachments: [],
      },
    },
    { runValidators: false }
  );

  // Emit socket event — wrapped so a socket failure does not 500 the request
  try {
    const io = getIO();
    const conversation = await SupraSpaceConversation.findById(
      message.conversationId
    ).lean();
    if (conversation) {
      conversation.members.forEach((memberId) => {
        io.to(`user:${memberId.toString()}`).emit('message:deleted', {
          conversationId: message.conversationId.toString(),
          messageId,
        });
      });
    }
  } catch (socketErr) {
    // Non-fatal — the DB update already succeeded
    console.warn('[SupraSpace] Socket emit failed on delete:', socketErr);
  }

  res.json(new ApiResponse(200, null, 'Message deleted'));
});

/**
 * GET /api/supraspace/users
 * List all active CRM users except the requester
 */
const getCrmUsers = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;

  const users = await CrmUser.find({ _id: { $ne: userId }, isActive: true })
    .select('fullName username avatar role')
    .sort({ fullName: 1 })
    .lean();

  res.json(new ApiResponse(200, users, 'Users fetched'));
});

const supraSpaceController = {
  getConversations,
  getOrCreateDirect,
  createGroup,
  updateConversation,
  getMessages,
  sendMessage,
  uploadAttachment,
  deleteMessage,
  getCrmUsers,
};

export default supraSpaceController;