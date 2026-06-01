import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import CrmUser from '../models/CrmUser.model';
import Organization from '../models/Organization.model';
import { storageService, BucketType } from '../services/storage.service';
import { getIO } from '../socket/supraspace.socket';
import logger from '../utils/logger';

// ─── Helpers (mirrored from aftermarket.controller.ts) ──────────────────────

const idIn = (arr: any[], id: any) =>
  (arr || []).map(String).includes(id.toString());

/**
 * Resolve the org a customer request should be scoped to.
 * Identical logic to aftermarket.controller.ts resolveCustomerOrg.
 */
async function resolveCustomerOrg(req: Request): Promise<string | undefined> {
  if (req.orgId) return req.orgId;

  const orgCount = await Organization.countDocuments({});
  if (orgCount === 1) {
    const only = await Organization.findOne().select('_id');
    if (only) return only._id.toString();
  }
  return undefined;
}

function emitToConversation(conv: any, event: string, payload: any) {
  try {
    const io = getIO();
    (conv.members || []).forEach((m: any) => {
      io.to(`user:${m.toString ? m.toString() : m}`).emit(event, payload);
    });
    if (conv._id) io.to(`conv:${conv._id.toString()}`).emit(event, payload);
  } catch (err) {
    logger.warn({ err, event }, '[CustomerConcern] Socket emit failed');
  }
}

async function signAttachments(message: any) {
  if (Array.isArray(message?.attachments)) {
    for (const a of message.attachments) {
      if (a.url && !a.url.startsWith('http')) {
        const signed = await storageService.getSignedUrl(a.fileKey || a.url);
        if (signed) { a.url = signed; if (a.thumbnailUrl) a.thumbnailUrl = signed; }
      }
    }
  }
  return message;
}

/**
 * All CRM staff who should be auto-members of every concern conversation.
 */
async function getCrmStaffIds(): Promise<mongoose.Types.ObjectId[]> {
  const staff = await CrmUser.find({
    isActive: true,
    role: { $in: ['admin', 'agent', 'sales_rep', 'manager', 'super_admin'] },
  }).select('_id').lean();
  return staff.map((u: any) => u._id);
}

/**
 * Build a stable, valid ObjectId for a customer from their string id.
 * The customer is not a CrmUser, so we derive a sentinel ID that is
 * consistent across messages from the same customer.
 */
function customerSentinelId(customerId: string): mongoose.Types.ObjectId {
  // Pad/truncate to 24 hex chars (12 bytes). This is deterministic per customer.
  const hex = Buffer.from(customerId.padEnd(12, '\0').slice(0, 12)).toString('hex');
  return new mongoose.Types.ObjectId(hex);
}

/**
 * Lazily get or create the single concern conversation for a customer.
 * orgId is used to scope staff membership in future multi-org setups.
 */
async function getOrCreateConcernConv(
  customerId: string,
  customerName: string,
  customerEmail: string,
  orgId?: string
): Promise<any> {
  let conversation = await SupraSpaceConversation.findOne({
    'metadata.type': 'customer_concern',
    'metadata.customerUserId': customerId,
    isActive: true,
  });

  if (!conversation) {
    const staffIds = await getCrmStaffIds();
    conversation = await SupraSpaceConversation.create({
      type: 'group',
      name: `${customerName} — Support`,
      members: staffIds,
      admins: [],
      createdBy: staffIds[0] || new mongoose.Types.ObjectId(),
      metadata: {
        type: 'customer_concern',
        customerUserId: customerId,
        customerName,
        customerEmail,
      },
    });
    emitToConversation(conversation, 'concern:new', conversation.toObject());
  }

  return conversation;
}

// ─── Customer-facing handlers ────────────────────────────────────────────────
//
// Auth: standard auth() middleware (same as aftermarket.route.ts).
// User identity lives on req.user._id (mongoose ObjectId) and req.user.
// Display name/email come from whatever fields your User model exposes —
// the same fields aftermarket.controller.ts uses for the customer object.

/**
 * GET /api/customer-concern/init
 * Returns (or lazily creates) the concern conversation for the logged-in customer.
 */
export const initConcernConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user?._id) throw new ApiError(401, 'Not authenticated');

    const orgId = await resolveCustomerOrg(req);
    if (!orgId) throw new ApiError(403, 'No organization context for this account.');

    const customerId = user._id.toString();
    const customerName =
      user.fullName || user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Customer';
    const customerEmail = user.email || user.primaryEmailAddress?.emailAddress || '';

    const conversation = await getOrCreateConcernConv(customerId, customerName, customerEmail, orgId);

    await SupraSpaceConversation.populate(conversation, {
      path: 'members',
      select: 'fullName username avatar role',
    });

    res.json(new ApiResponse(200, conversation, 'Concern conversation ready'));
  }
);

/**
 * GET /api/customer-concern/messages
 * Fetch message history for the customer's concern conversation.
 */
export const customerGetMessages = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user?._id) throw new ApiError(401, 'Not authenticated');

    const orgId = await resolveCustomerOrg(req);
    if (!orgId) throw new ApiError(403, 'No organization context for this account.');

    const customerId = user._id.toString();
    const { before, limit = '40' } = req.query;

    const conversation = await SupraSpaceConversation.findOne({
      'metadata.type': 'customer_concern',
      'metadata.customerUserId': customerId,
      isActive: true,
    });

    if (!conversation) {
      return res.json(new ApiResponse(200, [], 'No conversation yet'));
    }

    const filter: any = { conversationId: conversation._id, isDeleted: false };
    if (before) filter.createdAt = { $lt: new Date(before as string) };

    const messages = await SupraSpaceMessage.find(filter)
      .populate('sender', 'fullName username avatar')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit as string))
      .lean();

    // Hydrate the customer sender display info from metadata
    const hydrated = messages.map((m: any) => {
      if (m.metadata?.isCustomerMessage) {
        m.sender = {
          _id: m.metadata.customerUserId,
          fullName: m.metadata.customerName || 'Customer',
          avatar: m.metadata.customerAvatar || '',
          isCustomer: true,
        };
      }
      return m;
    });

    const signed = await Promise.all(hydrated.map(signAttachments));
    res.json(new ApiResponse(200, signed.reverse(), 'Messages fetched'));
  }
);

/**
 * POST /api/customer-concern/messages
 * Send a text message from the customer.
 */
export const customerSendMessage = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user?._id) throw new ApiError(401, 'Not authenticated');

    const orgId = await resolveCustomerOrg(req);
    if (!orgId) throw new ApiError(403, 'No organization context for this account.');

    const { content, replyTo } = req.body;
    if (!content?.trim()) throw new ApiError(400, 'Message content is required');

    const customerId = user._id.toString();
    const customerName =
      user.fullName || user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Customer';
    const customerEmail = user.email || user.primaryEmailAddress?.emailAddress || '';
    const customerAvatar = user.imageUrl || user.avatar || '';

    const conversation = await getOrCreateConcernConv(customerId, customerName, customerEmail, orgId);

    const sentinelId = customerSentinelId(customerId);

    const message = await SupraSpaceMessage.create({
      conversationId: conversation._id,
      sender: sentinelId,
      content: content.trim(),
      type: 'text',
      attachments: [],
      replyTo: replyTo || null,
      readBy: [],
      metadata: {
        isCustomerMessage: true,
        customerUserId: customerId,
        customerName,
        customerEmail,
        customerAvatar,
      },
    });

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const msgObj = message.toObject() as any;
    msgObj.sender = { _id: customerId, fullName: customerName, avatar: customerAvatar, isCustomer: true };

    emitToConversation(conversation, 'message:new', {
      conversationId: conversation._id.toString(),
      message: msgObj,
    });

    try {
      getIO().to('crm:staff').emit('concern:message', {
        conversationId: conversation._id.toString(),
        customerName,
        preview: content.trim().slice(0, 80),
      });
    } catch {}

    res.status(201).json(new ApiResponse(201, msgObj, 'Message sent'));
  }
);

/**
 * POST /api/customer-concern/upload
 * Upload file attachments from the customer.
 */
export const customerUploadAttachment = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user?._id) throw new ApiError(401, 'Not authenticated');

    const orgId = await resolveCustomerOrg(req);
    if (!orgId) throw new ApiError(403, 'No organization context for this account.');

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new ApiError(400, 'No files uploaded');

    const customerId = user._id.toString();
    const customerName =
      user.fullName || user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Customer';
    const customerEmail = user.email || user.primaryEmailAddress?.emailAddress || '';

    const conversation = await getOrCreateConcernConv(customerId, customerName, customerEmail, orgId);

    const attachments: any[] = [];
    for (const file of files) {
      let fileUrl: string;
      try {
        fileUrl = await storageService.upload(file, 'concern-attachments', BucketType.PRIVATE, {
          allowLocalFallback: false,
        });
      } catch (err: any) {
        logger.error({ err }, '[CustomerConcern] Upload failed');
        throw new ApiError(503, 'File upload temporarily unavailable. Please try again.');
      }
      const fileKey = storageService.getKeyFromUrl(fileUrl) || fileUrl;
      attachments.push({
        url: fileUrl,
        fileKey,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        thumbnailUrl: file.mimetype.startsWith('image/') ? fileUrl : undefined,
      });
    }

    const type =
      attachments.length === 1 && attachments[0].mimeType.startsWith('image/') ? 'image' : 'file';

    const sentinelId = customerSentinelId(customerId);

    const message = await SupraSpaceMessage.create({
      conversationId: conversation._id,
      sender: sentinelId,
      content: req.body.content?.trim() || '',
      type,
      attachments,
      readBy: [],
      metadata: {
        isCustomerMessage: true,
        customerUserId: customerId,
        customerName,
        customerEmail,
        customerAvatar: user.imageUrl || user.avatar || '',
      },
    });

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const msgObj = await signAttachments(message.toObject() as any);
    msgObj.sender = { _id: customerId, fullName: customerName, avatar: user.imageUrl || '', isCustomer: true };

    emitToConversation(conversation, 'message:new', {
      conversationId: conversation._id.toString(),
      message: msgObj,
    });

    res.status(201).json(new ApiResponse(201, msgObj, 'File sent'));
  }
);

// ─── CRM staff handlers ───────────────────────────────────────────────────────
// Auth: crmAuth() middleware — populates req.crmUser.

/**
 * GET /api/customer-concern/crm/conversations
 * All concern conversations, newest first, with unread badge counts.
 */
export const crmListConcernConversations = asyncHandler(
  async (req: Request, res: Response) => {
    const { search } = req.query;
    const crmUserId = (req as any).crmUser?._id;

    const query: any = { 'metadata.type': 'customer_concern', isActive: true };

    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { 'metadata.customerName': rx },
        { 'metadata.customerEmail': rx },
        { name: rx },
      ];
    }

    const conversations = await SupraSpaceConversation.find(query)
      .populate('members', 'fullName username avatar role')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'fullName username avatar' } })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .lean();

    const enriched = await Promise.all(
      conversations.map(async (c: any) => {
        const unread = await SupraSpaceMessage.countDocuments({
          conversationId: c._id,
          isDeleted: false,
          readBy: { $ne: crmUserId },
          'metadata.isCustomerMessage': true,
        });
        return { ...c, unreadCount: unread };
      })
    );

    res.json(new ApiResponse(200, enriched, 'Concern conversations fetched'));
  }
);

/**
 * GET /api/customer-concern/crm/conversations/:conversationId/messages
 */
export const crmGetConcernMessages = asyncHandler(
  async (req: Request, res: Response) => {
    const { conversationId } = req.params;
    const crmUserId = (req as any).crmUser?._id;
    const { before, limit = '40' } = req.query;

    const conversation = await SupraSpaceConversation.findOne({
      _id: conversationId,
      'metadata.type': 'customer_concern',
      isActive: true,
    });
    if (!conversation) throw new ApiError(404, 'Concern conversation not found');

    const filter: any = { conversationId, isDeleted: false };
    if (before) filter.createdAt = { $lt: new Date(before as string) };

    const messages = await SupraSpaceMessage.find(filter)
      .populate('sender', 'fullName username avatar')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit as string))
      .lean();

    // Mark customer messages as read by this CRM user
    await SupraSpaceMessage.updateMany(
      { conversationId, 'metadata.isCustomerMessage': true, readBy: { $ne: crmUserId } },
      { $addToSet: { readBy: crmUserId } }
    );

    const hydrated = messages.map((m: any) => {
      if (m.metadata?.isCustomerMessage) {
        m.sender = {
          _id: m.metadata.customerUserId,
          fullName: m.metadata.customerName || 'Customer',
          avatar: m.metadata.customerAvatar || '',
          isCustomer: true,
        };
      }
      return m;
    });

    const signed = await Promise.all(hydrated.map(signAttachments));
    res.json(new ApiResponse(200, signed.reverse(), 'Messages fetched'));
  }
);

/**
 * POST /api/customer-concern/crm/conversations/:conversationId/reply
 */
export const crmReplyConcern = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = (req as any).crmUser!;
  const { conversationId } = req.params;
  const { content, replyTo } = req.body;

  if (!content?.trim()) throw new ApiError(400, 'Content is required');

  const conversation = await SupraSpaceConversation.findOne({
    _id: conversationId,
    'metadata.type': 'customer_concern',
    isActive: true,
  });
  if (!conversation) throw new ApiError(404, 'Concern conversation not found');

  // Auto-add this CRM user as a member if they aren't already
  if (!idIn(conversation.members as any, crmUser._id)) {
    conversation.members.push(crmUser._id as any);
    await conversation.save();
  }

  const message = await SupraSpaceMessage.create({
    conversationId,
    sender: crmUser._id,
    content: content.trim(),
    type: 'text',
    attachments: [],
    replyTo: replyTo || null,
    readBy: [crmUser._id],
    metadata: {
      isCustomerMessage: false,
      crmUserName: crmUser.fullName,
      crmUserRole: crmUser.role,
    },
  });

  await message.populate('sender', 'fullName username avatar');

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const msgObj = await signAttachments(message.toObject() as any);

  emitToConversation(conversation, 'message:new', { conversationId, message: msgObj });

  // Notify the customer in real time
  const customerUserId = (conversation as any).metadata?.customerUserId;
  if (customerUserId) {
    try {
      getIO().to(`user:${customerUserId}`).emit('concern:reply', { conversationId, message: msgObj });
    } catch {}
  }

  res.status(201).json(new ApiResponse(201, msgObj, 'Reply sent'));
});

/**
 * PATCH /api/customer-concern/crm/conversations/:conversationId/resolve
 */
export const crmResolveConcern = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const { resolved } = req.body;

  const conversation = await SupraSpaceConversation.findOne({
    _id: conversationId,
    'metadata.type': 'customer_concern',
  });
  if (!conversation) throw new ApiError(404, 'Concern conversation not found');

  (conversation as any).metadata.resolved = !!resolved;
  (conversation as any).metadata.resolvedAt = resolved ? new Date() : null;
  conversation.markModified('metadata');
  await conversation.save();

  emitToConversation(conversation, 'concern:resolved', { conversationId, resolved: !!resolved });

  const customerUserId = (conversation as any).metadata?.customerUserId;
  if (customerUserId) {
    try {
      getIO()
        .to(`user:${customerUserId}`)
        .emit('concern:resolved', { conversationId, resolved: !!resolved });
    } catch {}
  }

  res.json(
    new ApiResponse(200, { conversationId, resolved: !!resolved }, resolved ? 'Concern resolved' : 'Concern reopened')
  );
});