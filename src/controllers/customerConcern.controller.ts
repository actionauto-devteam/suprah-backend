import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import CrmUser from '../models/CrmUser.model';
import CustomerUser from '../models/User.model'; 
import { getIO } from '../socket/supraspace.socket';
import { storageService, BucketType } from '../services/storage.service';
import logger from '../utils/logger';

// ─── Helpers ────────────────────────────────────────────────────────────────

const idIn = (arr: any[], id: any) =>
  (arr || []).map(String).includes(id.toString());

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
 * Returns all CRM users that should be auto-members of concern conversations.
 * Extend this as needed (e.g. filter by organizationId).
 */
async function getCrmStaffIds(): Promise<mongoose.Types.ObjectId[]> {
  const staff = await CrmUser.find({
    isActive: true,
    role: { $in: ['admin', 'agent', 'sales_rep', 'manager', 'super_admin'] },
  }).select('_id').lean();
  return staff.map((u: any) => u._id);
}

// ─── Init / get concern conversation ───────────────────────────────────────

/**
 * GET /api/customer-concern/init
 *
 * Called by the customer UI on load. Returns (or lazily creates) the one
 * concern conversation for this customer.
 *
 * Requires: req.customerUser (set by customer auth middleware)
 */
export const initConcernConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const customerId = (req as any).customerUser?._id;
    if (!customerId) throw new ApiError(401, 'Not authenticated as customer');

    const customer = await CustomerUser.findById(customerId).lean();
    if (!customer) throw new ApiError(404, 'Customer not found');

    // Check for existing concern conversation
    let conversation = await SupraSpaceConversation.findOne({
      'metadata.type': 'customer_concern',
      'metadata.customerUserId': customerId.toString(),
      isActive: true,
    })
      .populate('members', 'fullName username avatar role')
      .lean();

    if (!conversation) {
      // Create new concern conversation with all CRM staff as members
      const staffIds = await getCrmStaffIds();
      const uniqueMembers = [...new Set([...staffIds.map(String)])];

      const newConv = await SupraSpaceConversation.create({
        type: 'group', // stored as group so multi-staff can join
        name: `${(customer as any).fullName || (customer as any).name || 'Customer'} — Support`,
        members: uniqueMembers,
        admins: [],
        createdBy: staffIds[0] || new mongoose.Types.ObjectId(),
        metadata: {
          type: 'customer_concern',
          customerUserId: customerId.toString(),
          customerName: (customer as any).fullName || (customer as any).name || 'Customer',
          customerEmail: (customer as any).email || '',
        },
      });

      await newConv.populate('members', 'fullName username avatar role');

      // Emit to all staff so the conversation appears immediately
      emitToConversation(newConv, 'concern:new', newConv.toObject());

      conversation = newConv.toObject() as any;
    }

    res.json(new ApiResponse(200, conversation, 'Concern conversation ready'));
  }
);

// ─── Customer: send message ─────────────────────────────────────────────────

/**
 * POST /api/customer-concern/messages
 * Body: { content, attachments? }
 *
 * Sends a message from the customer into their concern conversation.
 * The sender is stored as a virtual "customer sender" object because
 * customers are not CrmUsers — the message is tagged with
 * metadata.customerSender for display purposes.
 */
export const customerSendMessage = asyncHandler(
  async (req: Request, res: Response) => {
    const customerId = (req as any).customerUser?._id;
    if (!customerId) throw new ApiError(401, 'Not authenticated as customer');

    const customer = await CustomerUser.findById(customerId).lean();
    if (!customer) throw new ApiError(404, 'Customer not found');

    const { content, attachments, replyTo } = req.body;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!content?.trim() && !hasAttachments) {
      throw new ApiError(400, 'Message content is required');
    }

    // Find or lazily create the concern conversation
    let conversation = await SupraSpaceConversation.findOne({
      'metadata.type': 'customer_concern',
      'metadata.customerUserId': customerId.toString(),
      isActive: true,
    });

    if (!conversation) {
      // Lazy-create (same logic as initConcernConversation)
      const staffIds = await getCrmStaffIds();
      conversation = await SupraSpaceConversation.create({
        type: 'group',
        name: `${(customer as any).fullName || 'Customer'} — Support`,
        members: staffIds,
        admins: [],
        createdBy: staffIds[0] || new mongoose.Types.ObjectId(),
        metadata: {
          type: 'customer_concern',
          customerUserId: customerId.toString(),
          customerName: (customer as any).fullName || (customer as any).name || 'Customer',
          customerEmail: (customer as any).email || '',
        },
      });
      emitToConversation(conversation, 'concern:new', conversation.toObject());
    }

    // Use a sentinel ObjectId for the customer sender (not a real CrmUser).
    // We tag metadata.customerSender with the display info instead.
    const CUSTOMER_SENTINEL_ID = new mongoose.Types.ObjectId(
      Buffer.from(customerId.toString().padEnd(24, '0').slice(0, 24), 'utf8').toString('hex').slice(0, 24)
    );

    const message = await SupraSpaceMessage.create({
      conversationId: conversation._id,
      sender: CUSTOMER_SENTINEL_ID,
      content: content?.trim() || '',
      type: hasAttachments ? 'file' : 'text',
      attachments: hasAttachments ? attachments : [],
      replyTo: replyTo || null,
      readBy: [],
      metadata: {
        isCustomerMessage: true,
        customerUserId: customerId.toString(),
        customerName: (customer as any).fullName || (customer as any).name || 'Customer',
        customerEmail: (customer as any).email || '',
        customerAvatar: (customer as any).avatar || (customer as any).imageUrl || '',
      },
    });

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const msgObj = await signAttachments(message.toObject() as any);

    // Attach virtual sender for the client so it renders correctly
    (msgObj as any).sender = {
      _id: CUSTOMER_SENTINEL_ID.toString(),
      fullName: (customer as any).fullName || (customer as any).name || 'Customer',
      avatar: (customer as any).avatar || (customer as any).imageUrl || '',
      isCustomer: true,
    };

    emitToConversation(conversation, 'message:new', {
      conversationId: conversation._id.toString(),
      message: msgObj,
    });

    // Also emit a dedicated event for the CRM concern tab badge / notification
    getIO()
      .to('crm:staff')
      .emit('concern:message', {
        conversationId: conversation._id.toString(),
        customerName: (customer as any).fullName || 'Customer',
        preview: content?.trim()?.slice(0, 80) || '📎 Attachment',
      });

    res.status(201).json(new ApiResponse(201, msgObj, 'Message sent'));
  }
);

// ─── Customer: upload attachment ────────────────────────────────────────────

export const customerUploadAttachment = asyncHandler(
  async (req: Request, res: Response) => {
    const customerId = (req as any).customerUser?._id;
    if (!customerId) throw new ApiError(401, 'Not authenticated as customer');

    const customer = await CustomerUser.findById(customerId).lean();
    if (!customer) throw new ApiError(404, 'Customer not found');

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new ApiError(400, 'No files uploaded');

    let conversation = await SupraSpaceConversation.findOne({
      'metadata.type': 'customer_concern',
      'metadata.customerUserId': customerId.toString(),
      isActive: true,
    });

    if (!conversation) {
      const staffIds = await getCrmStaffIds();
      conversation = await SupraSpaceConversation.create({
        type: 'group',
        name: `${(customer as any).fullName || 'Customer'} — Support`,
        members: staffIds,
        admins: [],
        createdBy: staffIds[0] || new mongoose.Types.ObjectId(),
        metadata: {
          type: 'customer_concern',
          customerUserId: customerId.toString(),
          customerName: (customer as any).fullName || (customer as any).name || 'Customer',
          customerEmail: (customer as any).email || '',
        },
      });
    }

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

    const CUSTOMER_SENTINEL_ID = new mongoose.Types.ObjectId(
      Buffer.from(customerId.toString().padEnd(24, '0').slice(0, 24), 'utf8').toString('hex').slice(0, 24)
    );

    const type =
      attachments.length === 1 && attachments[0].mimeType.startsWith('image/')
        ? 'image'
        : 'file';

    const message = await SupraSpaceMessage.create({
      conversationId: conversation._id,
      sender: CUSTOMER_SENTINEL_ID,
      content: req.body.content?.trim() || '',
      type,
      attachments,
      readBy: [],
      metadata: {
        isCustomerMessage: true,
        customerUserId: customerId.toString(),
        customerName: (customer as any).fullName || (customer as any).name || 'Customer',
        customerEmail: (customer as any).email || '',
      },
    });

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const msgObj = await signAttachments(message.toObject() as any);
    (msgObj as any).sender = {
      _id: CUSTOMER_SENTINEL_ID.toString(),
      fullName: (customer as any).fullName || (customer as any).name || 'Customer',
      avatar: (customer as any).avatar || '',
      isCustomer: true,
    };

    emitToConversation(conversation, 'message:new', {
      conversationId: conversation._id.toString(),
      message: msgObj,
    });

    res.status(201).json(new ApiResponse(201, msgObj, 'File sent'));
  }
);

// ─── Customer: fetch messages ───────────────────────────────────────────────

export const customerGetMessages = asyncHandler(
  async (req: Request, res: Response) => {
    const customerId = (req as any).customerUser?._id;
    if (!customerId) throw new ApiError(401, 'Not authenticated as customer');

    const { before, limit = '40' } = req.query;

    const conversation = await SupraSpaceConversation.findOne({
      'metadata.type': 'customer_concern',
      'metadata.customerUserId': customerId.toString(),
      isActive: true,
    });

    if (!conversation) {
      return res.json(new ApiResponse(200, [], 'No conversation yet'));
    }

    const filter: any = { conversationId: conversation._id, isDeleted: false };
    if (before) filter.createdAt = { $lt: new Date(before as string) };

    const messages = await SupraSpaceMessage.find(filter)
      .populate('sender', 'fullName username avatar')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit as string))
      .lean();

    // Hydrate customer sender metadata so the UI renders correctly
    const hydrated = messages.map((m: any) => {
      if (m.metadata?.isCustomerMessage) {
        m.sender = {
          _id: m.sender?._id || m.metadata.customerUserId,
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

// ─── CRM: list all concern conversations ───────────────────────────────────

/**
 * GET /api/customer-concern/crm/conversations
 *
 * Used by the new "Customer's Concern" tab in the Appointments page.
 * Returns all active concern conversations with last message preview,
 * sorted by most recent activity. Requires crmAuth.
 */
export const crmListConcernConversations = asyncHandler(
  async (req: Request, res: Response) => {
    const { search, status } = req.query;

    const query: any = {
      'metadata.type': 'customer_concern',
      isActive: true,
    };

    if (search) {
      const rx = new RegExp(search as string, 'i');
      query.$or = [
        { 'metadata.customerName': rx },
        { 'metadata.customerEmail': rx },
        { name: rx },
      ];
    }

    const conversations = await SupraSpaceConversation.find(query)
      .populate('members', 'fullName username avatar role')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'fullName username avatar' },
      })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .lean();

    // Attach unread count per conversation for badge display
    const userId = (req as any).crmUser?._id;
    const enriched = await Promise.all(
      conversations.map(async (c: any) => {
        const unread = await SupraSpaceMessage.countDocuments({
          conversationId: c._id,
          isDeleted: false,
          readBy: { $ne: userId },
          'metadata.isCustomerMessage': true,
        });
        return { ...c, unreadCount: unread };
      })
    );

    res.json(new ApiResponse(200, enriched, 'Concern conversations fetched'));
  }
);

// ─── CRM: get messages for a concern conversation ──────────────────────────

export const crmGetConcernMessages = asyncHandler(
  async (req: Request, res: Response) => {
    const { conversationId } = req.params;
    const userId = (req as any).crmUser?._id;
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
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit as string))
      .lean();

    // Mark as read
    await SupraSpaceMessage.updateMany(
      { conversationId, readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
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

// ─── CRM: reply to a concern conversation ──────────────────────────────────

export const crmReplyConcern = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = (req as any).crmUser!;
  const { conversationId } = req.params;
  const { content, attachments, replyTo } = req.body;

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!content?.trim() && !hasAttachments) throw new ApiError(400, 'Content is required');

  const conversation = await SupraSpaceConversation.findOne({
    _id: conversationId,
    'metadata.type': 'customer_concern',
    isActive: true,
  });

  if (!conversation) throw new ApiError(404, 'Concern conversation not found');

  // Ensure this CRM user is a member (auto-add if not)
  if (!idIn(conversation.members as any, crmUser._id)) {
    conversation.members.push(crmUser._id as any);
    await conversation.save();
  }

  const message = await SupraSpaceMessage.create({
    conversationId,
    sender: crmUser._id,
    content: content?.trim() || '',
    type: hasAttachments ? 'file' : 'text',
    attachments: hasAttachments ? attachments : [],
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

  // Emit to the conversation room (staff) + the customer's personal room
  emitToConversation(conversation, 'message:new', {
    conversationId,
    message: msgObj,
  });

  // Emit to the customer's socket room so they receive the reply in real-time
  const customerUserId = conversation.get('metadata.customerUserId');
  if (customerUserId) {
    try {
      getIO().to(`customer:${customerUserId}`).emit('concern:reply', {
        conversationId,
        message: msgObj,
      });
    } catch {}
  }

  res.status(201).json(new ApiResponse(201, msgObj, 'Reply sent'));
});

// ─── CRM: resolve / reopen concern ─────────────────────────────────────────

export const crmResolveConcern = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const { resolved } = req.body;

  const conversation = await SupraSpaceConversation.findOne({
    _id: conversationId,
    'metadata.type': 'customer_concern',
  });

  if (!conversation) throw new ApiError(404, 'Concern conversation not found');

  conversation.set('metadata.resolved', !!resolved);
  conversation.set('metadata.resolvedAt', resolved ? new Date() : null);
  await conversation.save();

  emitToConversation(conversation, 'concern:resolved', {
    conversationId,
    resolved: !!resolved,
  });

  // Notify the customer
  const customerUserId = conversation.get('metadata.customerUserId');
  if (customerUserId) {
    try {
      getIO()
        .to(`customer:${customerUserId}`)
        .emit('concern:resolved', { conversationId, resolved: !!resolved });
    } catch {}
  }

  res.json(
    new ApiResponse(200, { conversationId, resolved }, resolved ? 'Concern resolved' : 'Concern reopened')
  );
});