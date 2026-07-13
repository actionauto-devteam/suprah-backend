import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import CrmUser from '../models/CrmUser.model';
import User, { IUser } from '../models/User.model';
import { getIO } from '../socket/supraspace.socket';
import { emitToUser } from '../utils/socketEmitter';
import logger from '../utils/logger';
import jwt from 'jsonwebtoken';



const idIn = (arr: any[], id: any) =>
  (arr || []).map(String).includes(id.toString());

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function emitToConversation(conv: any, event: string, payload: any) {
  try {
    const io = getIO();
    (conv.members || []).forEach((m: any) => {
      io.to(`user:${m.toString ? m.toString() : m}`).emit(event, payload);
    });
    if (conv._id) io.to(`conv:${conv._id.toString()}`).emit(event, payload);
  } catch (err) {
    console.warn(`[CustomerCall] Socket emit failed on ${event}:`, err);
  }
}

/** Notify the customer's main-app socket room directly (one-way push). */
function emitToCustomer(customerUserId: string, event: string, payload: any) {
  emitToUser(customerUserId, event, payload);
}

const VALID_MODES = ['voice', 'video'] as const;
type CallMode = (typeof VALID_MODES)[number];

const VALID_STATUSES = [
  'idle',       // no active request
  'requested',  // customer asked for a call
  'preparing',  // "Please wait while we prepare"
  'about_to_start', // "We are about to start the call"
  'in_progress', // staff started the Jitsi session
  'ended',      // call finished
  'declined',   // staff declined / cancelled
] as const;
type CallStatus = (typeof VALID_STATUSES)[number];

/** Predefined staff → customer notifications (kept server-side for trust). */
const PRESET_MESSAGES: Record<string, { status: CallStatus; text: string }> = {
  preparing: { status: 'preparing', text: 'Please wait while we prepare.' },
  about_to_start: { status: 'about_to_start', text: 'We are about to start the call.' },
  joining_now: { status: 'about_to_start', text: 'Our team is joining now — please get ready.' },
  brief_delay: { status: 'preparing', text: 'Apologies for the short delay, we will be with you shortly.' },
  declined: { status: 'declined', text: 'We are unable to take your call right now. Please try again later.' },
};

function roomNameFor(conversationId: string) {
  return `supracall-${conversationId}`;
}

function jitsiTokenFor(opts: {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  room: string;
}) {
  const payload = {
    context: {
      user: {
        id: opts.id,
        name: opts.name,
        avatar: opts.avatar,
        email: opts.email,
      },
    },
    aud: process.env.JITSI_APP_ID,
    iss: process.env.JITSI_APP_ID,
    sub: process.env.NEXT_PUBLIC_JITSI_DOMAIN,
    room: opts.room,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  };
  return jwt.sign(payload, process.env.JITSI_APP_SECRET || 'secret');
}

/** Shape a conversation doc into the lightweight payload the clients expect. */
function shapeConversation(conv: any) {
  return {
    _id: conv._id,
    name: conv.name,
    metadata: conv.metadata,
    lastMessageAt: conv.lastMessageAt,
    members: conv.members,
  };
}

// ─── Customer side ───────────────────────────────────────────────────────────

/**
 * GET /api/customer-call/init
 * Resolve (or lazily create) the calling customer's call conversation.
 * Auth: mainAuth (req.user is the main-app customer).
 */
const init = asyncHandler(async (req: Request, res: Response) => {
  const mainUser = req.user as IUser;
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const customerUserId = mainUser._id.toString();

  let conversation: any = await SupraSpaceConversation.findOne({
    'metadata.type': 'customer_call',
    'metadata.customerUserId': customerUserId,
    isActive: true,
  }).lean();

  if (!conversation) {
    // Staff members of the org who can field calls become channel members.
    const staff = await CrmUser.find({ organizationId: orgId, isActive: true })
      .select('_id')
      .lean();
    const staffIds = staff.map((s: any) => s._id);

    const created = await SupraSpaceConversation.create({
      type: 'group',
      name: `${mainUser.name || 'Customer'} — Call`,
      members: staffIds.length ? staffIds : [],
      admins: [],
      createdBy: staffIds[0] || mainUser._id,
      metadata: {
        type: 'customer_call',
        customerUserId,
        customerName: mainUser.name || 'Customer',
        customerEmail: mainUser.email || null,
        resolved: false,
      },
    });
    conversation = created.toObject();
  }

  res.json(new ApiResponse(200, shapeConversation(conversation), 'Call channel ready'));
});

/**
 * POST /api/customer-call/request   { mode: 'voice' | 'video' }
 * Customer initiates a call request. Records a system message and flips the
 * conversation status to 'requested', notifying staff in real time.
 * Auth: mainAuth.
 */
const requestCall = asyncHandler(async (req: Request, res: Response) => {
  const mainUser = req.user as IUser;
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(403, 'Your account is not linked to any organization.');

  const { mode } = req.body as { mode?: CallMode };
  if (!mode || !VALID_MODES.includes(mode)) {
    throw new ApiError(400, "mode must be 'voice' or 'video'");
  }

  const customerUserId = mainUser._id.toString();

  const conversation = await SupraSpaceConversation.findOne({
    'metadata.type': 'customer_call',
    'metadata.customerUserId': customerUserId,
    isActive: true,
  });
  if (!conversation) throw new ApiError(404, 'Call channel not found. Please reopen the page.');

  // Update call metadata
  (conversation.metadata as any).callMode = mode;
  (conversation.metadata as any).callStatus = 'requested';
  (conversation.metadata as any).requestedAt = new Date();
  (conversation.metadata as any).resolved = false;
  conversation.markModified('metadata');

  // System message recording the request (sender is a staff/system placeholder).
  const systemMessage = await SupraSpaceMessage.create({
    conversationId: conversation._id,
    sender: conversation.createdBy,
    type: 'system',
    content: `Customer requested a ${mode} call.`,
    readBy: [],
    metadata: {
      isCustomerMessage: true,
      customerUserId,
      customerName: mainUser.name || 'Customer',
      customerEmail: mainUser.email || null,
    },
  });

  conversation.lastMessage = systemMessage._id as any;
  conversation.lastMessageAt = systemMessage.createdAt;
  await conversation.save();

  const payload = {
    conversationId: conversation._id.toString(),
    customerUserId,
    customerName: mainUser.name || 'Customer',
    mode,
    status: 'requested' as CallStatus,
    at: systemMessage.createdAt,
  };

  // Notify staff members (channel) of the incoming request.
  emitToConversation(conversation, 'call:request', payload);

  res.status(201).json(
    new ApiResponse(201, { conversationId: conversation._id, mode, status: 'requested' }, 'Call requested')
  );
});

/**
 * GET /api/customer-call/messages
 * Customer reads the status timeline (read-only). Auth: mainAuth.
 */
const getCustomerMessages = asyncHandler(async (req: Request, res: Response) => {
  const mainUser = req.user as IUser;
  const customerUserId = mainUser._id.toString();
  const { before, limit = '40' } = req.query;

  const conversation = await SupraSpaceConversation.findOne({
    'metadata.type': 'customer_call',
    'metadata.customerUserId': customerUserId,
    isActive: true,
  }).lean();
  if (!conversation) return res.json(new ApiResponse(200, [], 'No call channel yet'));

  const filter: any = { conversationId: conversation._id, isDeleted: false };
  if (before) filter.createdAt = { $lt: new Date(before as string) };

  const messages = await SupraSpaceMessage.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit as string))
    .lean();

  res.json(new ApiResponse(200, messages.reverse(), 'Call messages fetched'));
});

/**
 * GET /api/customer-call/video-token
 * Issues a Jitsi token for the customer to join, but ONLY when staff has
 * started the session (status === 'in_progress'). Auth: mainAuth.
 */
const getCustomerVideoToken = asyncHandler(async (req: Request, res: Response) => {
  const mainUser = req.user as IUser;
  const customerUserId = mainUser._id.toString();

  const conversation = await SupraSpaceConversation.findOne({
    'metadata.type': 'customer_call',
    'metadata.customerUserId': customerUserId,
    isActive: true,
  }).lean();
  if (!conversation) throw new ApiError(404, 'Call channel not found');

  const status = (conversation.metadata as any)?.callStatus as CallStatus | undefined;
  if (status !== 'in_progress' && status !== 'about_to_start') {
    throw new ApiError(409, 'The call has not started yet. Please wait for the team.');
  }

  const room = roomNameFor(conversation._id.toString());
  const token = jitsiTokenFor({
    id: customerUserId,
    name: mainUser.name || 'Customer',
    email: mainUser.email,
    room,
  });

  res.json(
    new ApiResponse(
      200,
      { token, roomName: room, mode: (conversation.metadata as any)?.callMode || 'video' },
      'Video token generated'
    )
  );
});

// ─── Staff (CRM) side ──────────────────────────────────────────────────────

/**
 * GET /api/customer-call/crm/conversations?search=
 * Staff list of call requests for the org. Auth: crmAuth.
 */
const crmGetConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const search = (req.query.search as string) || '';

  const filter: any = {
    'metadata.type': 'customer_call',
    members: userId,
    isActive: true,
  };
  if (search.trim()) {
    const rx = new RegExp(escapeRegex(search.trim()), 'i');
    filter.$or = [{ 'metadata.customerName': rx }, { 'metadata.customerEmail': rx }];
  }

  const conversations = await SupraSpaceConversation.find(filter)
    .populate('members', 'fullName username avatar role')
    .sort({ lastMessageAt: -1 })
    .lean();

  // Attach unread counts (messages from the customer the staff hasn't read).
  const withUnread = await Promise.all(
    conversations.map(async (c: any) => {
      const unreadCount = await SupraSpaceMessage.countDocuments({
        conversationId: c._id,
        isDeleted: false,
        'metadata.isCustomerMessage': true,
        readBy: { $ne: userId },
      });
      return { ...c, unreadCount };
    })
  );

  res.json(new ApiResponse(200, withUnread, 'Call conversations fetched'));
});

/**
 * GET /api/customer-call/crm/conversations/:id/messages
 * Staff reads the full timeline and marks customer messages read. Auth: crmAuth.
 */
const crmGetMessages = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { id } = req.params;
  const { before, limit = '40' } = req.query;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const filter: any = { conversationId: id, isDeleted: false };
  if (before) filter.createdAt = { $lt: new Date(before as string) };

  const messages = await SupraSpaceMessage.find(filter)
    .populate('sender', 'fullName username avatar role')
    .sort({ createdAt: -1 })
    .limit(parseInt(limit as string))
    .lean();

  await SupraSpaceMessage.updateMany(
    { conversationId: id, readBy: { $ne: userId } },
    { $addToSet: { readBy: userId } }
  );

  res.json(new ApiResponse(200, messages.reverse(), 'Messages fetched'));
});

/**
 * POST /api/customer-call/crm/conversations/:id/status
 *   { preset?: string, status?: CallStatus, text?: string }
 * Staff sends a one-way status update to the customer. Either a `preset`
 * key (server-defined) or a custom { status, text } pair. Auth: crmAuth.
 */
const crmSendStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id;
  const { id } = req.params;
  const { preset, status: customStatus, text: customText } = req.body as {
    preset?: string;
    status?: CallStatus;
    text?: string;
  };

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if ((conversation.metadata as any)?.type !== 'customer_call') {
    throw new ApiError(400, 'Not a call conversation');
  }
  if (!idIn(conversation.members as any, userId)) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  let status: CallStatus;
  let text: string;

  if (preset && PRESET_MESSAGES[preset]) {
    status = PRESET_MESSAGES[preset].status;
    text = PRESET_MESSAGES[preset].text;
  } else {
    if (!customText?.trim()) throw new ApiError(400, 'A preset or message text is required');
    status = customStatus && VALID_STATUSES.includes(customStatus) ? customStatus : 'preparing';
    text = customText.trim();
  }

  // Persist as a staff system message.
  const message = await SupraSpaceMessage.create({
    conversationId: conversation._id,
    sender: userId,
    type: 'system',
    content: text,
    readBy: [userId],
    metadata: {
      isCustomerMessage: false,
      crmUserName: user.fullName,
      crmUserRole: user.role,
    },
  });

  (conversation.metadata as any).callStatus = status;
  conversation.markModified('metadata');
  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const customerUserId = (conversation.metadata as any)?.customerUserId;
  const payload = {
    conversationId: conversation._id.toString(),
    status,
    text,
    crmUserName: user.fullName,
    at: message.createdAt,
    message,
  };

  // Push a one-way popup to the customer + keep staff views in sync.
  if (customerUserId) emitToCustomer(customerUserId, 'call:status', payload);
  emitToConversation(conversation, 'call:status', payload);

  res.status(201).json(new ApiResponse(201, payload, 'Status sent'));
});

/**
 * POST /api/customer-call/crm/conversations/:id/start
 * Staff starts the Jitsi session: flips status to in_progress, issues the
 * staff token, and pushes a join signal (with token) to the customer. Auth: crmAuth.
 */
const crmStartCall = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id;
  const { id } = req.params;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if ((conversation.metadata as any)?.type !== 'customer_call') {
    throw new ApiError(400, 'Not a call conversation');
  }
  if (!idIn(conversation.members as any, userId)) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const room = roomNameFor(conversation._id.toString());
  const mode = (conversation.metadata as any)?.callMode || 'video';

  (conversation.metadata as any).callStatus = 'in_progress';
  (conversation.metadata as any).callStartedAt = new Date();
  conversation.markModified('metadata');

  const message = await SupraSpaceMessage.create({
    conversationId: conversation._id,
    sender: userId,
    type: 'system',
    content: `The ${mode} call has started. Tap to join.`,
    readBy: [userId],
    metadata: { isCustomerMessage: false, crmUserName: user.fullName, crmUserRole: user.role },
  });

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  // Staff token (the one returned to the caller).
  const staffToken = jitsiTokenFor({
    id: userId.toString(),
    name: user.fullName,
    email: user.username,
    avatar: (user as any).avatar,
    room,
  });

  const customerUserId = (conversation.metadata as any)?.customerUserId;
  const startedPayload = {
    conversationId: conversation._id.toString(),
    status: 'in_progress' as CallStatus,
    mode,
    roomName: room,
    text: message.content,
    crmUserName: user.fullName,
    at: message.createdAt,
  };

  // Tell the customer the call is live (they fetch their own token via the
  // gated /video-token endpoint — we don't ship the staff token to them).
  if (customerUserId) {
    emitToCustomer(customerUserId, 'call:started', startedPayload);
    emitToCustomer(customerUserId, 'call:status', { ...startedPayload, message });
  }
  emitToConversation(conversation, 'call:started', startedPayload);

  res.status(201).json(
    new ApiResponse(201, { token: staffToken, roomName: room, mode, status: 'in_progress' }, 'Call started')
  );
});

/**
 * POST /api/customer-call/crm/conversations/:id/end
 * Staff ends/cancels the call. Auth: crmAuth.
 */
const crmEndCall = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id;
  const { id } = req.params;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  (conversation.metadata as any).callStatus = 'ended';
  (conversation.metadata as any).resolved = true;
  (conversation.metadata as any).resolvedAt = new Date();
  conversation.markModified('metadata');

  const message = await SupraSpaceMessage.create({
    conversationId: conversation._id,
    sender: userId,
    type: 'system',
    content: 'The call has ended. Thank you!',
    readBy: [userId],
    metadata: { isCustomerMessage: false, crmUserName: user.fullName, crmUserRole: user.role },
  });

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const customerUserId = (conversation.metadata as any)?.customerUserId;
  const payload = {
    conversationId: conversation._id.toString(),
    status: 'ended' as CallStatus,
    text: message.content,
    at: message.createdAt,
    message,
  };
  if (customerUserId) emitToCustomer(customerUserId, 'call:status', payload);
  emitToConversation(conversation, 'call:status', payload);

  res.json(new ApiResponse(200, payload, 'Call ended'));
});

/**
 * GET /api/customer-call/crm/conversations/:id/video-token
 * Staff token to (re)join the room. Auth: crmAuth.
 */
const crmGetVideoToken = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  const userId = user._id;
  const { id } = req.params;

  const conversation = await SupraSpaceConversation.findById(id);
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conversation.members as any, userId)) {
    throw new ApiError(403, 'Not a member of this conversation');
  }

  const room = roomNameFor(conversation._id.toString());
  const token = jitsiTokenFor({
    id: userId.toString(),
    name: user.fullName,
    email: user.username,
    avatar: (user as any).avatar,
    room,
  });

  res.json(
    new ApiResponse(
      200,
      { token, roomName: room, mode: (conversation.metadata as any)?.callMode || 'video' },
      'Video token generated'
    )
  );
});

const customerCallController = {
  // customer
  init,
  requestCall,
  getCustomerMessages,
  getCustomerVideoToken,
  // staff
  crmGetConversations,
  crmGetMessages,
  crmSendStatus,
  crmStartCall,
  crmEndCall,
  crmGetVideoToken,
};

export default customerCallController;