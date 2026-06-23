import { Request, Response } from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Call, { ICall } from '../models/Call.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import { getIO } from '../socket/supraspace.socket';
import { generateJaasToken, jaasRoomName, jaasConfigured, JAAS_DOMAIN } from '../services/jaas.service';
import config from '../config';

const idIn = (arr: any[], id: any) => (arr || []).map(String).includes(id.toString());
const DEFAULT_MEETING_DOMAIN = 'actionautoutah.com';

const formatDuration = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`
    : `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
};

async function emitToConversationMembers(conversationId: any, event: string, payload: any) {
  try {
    const io = getIO();
    const conv = await SupraSpaceConversation.findById(conversationId).select('members').lean();
    (conv?.members || []).forEach((m: any) => io.to(`user:${m.toString()}`).emit(event, payload));
    io.to(`conv:${conversationId.toString()}`).emit(event, payload);
  } catch (err) {
    console.warn('[Calls] emit failed:', event, err);
  }
}

async function assertMember(conversationId: string, userId: any) {
  const conv = await SupraSpaceConversation.findById(conversationId).select('members');
  if (!conv) throw new ApiError(404, 'Conversation not found');
  if (!idIn(conv.members as any, userId)) throw new ApiError(403, 'Not a member of this conversation');
  return conv;
}

/** Build the per-user Jitsi/JaaS payload (identity + moderator flag baked into the token). */
function buildJitsi(call: ICall, crmUser: any, isModerator: boolean) {
  if (!jaasConfigured()) {
    // Fallback (public meet.jit.si or self-host without JaaS): no JWT, identity via userInfo only.
    return { domain: JAAS_DOMAIN, room: call.roomName, jwt: undefined as string | undefined };
  }
  const jwt = generateJaasToken({
    user: {
      id: crmUser._id.toString(),
      name: crmUser.fullName,
      email: crmUser.email,
      avatar: crmUser.avatar,
      moderator: isModerator,
    },
  });
  return { domain: JAAS_DOMAIN, room: jaasRoomName(call.roomName), jwt };
}

function buildMeetingLink(meetingId: string) {
  const base = (config.frontendUrl || '').replace(/\/$/, '');
  return `${base}/crm/supra-space?meeting=${encodeURIComponent(meetingId)}`;
}

function hasAllowedDomain(email?: string, domain = DEFAULT_MEETING_DOMAIN) {
  return String(email || '').toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}

function isApprovedForMeeting(call: ICall, userId: any, email?: string) {
  if (hasAllowedDomain(email, call.allowedDomain)) return true;
  if (call.moderatorUserId.toString() === userId.toString()) return true;
  if (idIn(call.approvedUsers as any, userId)) return true;
  return call.admissionRequests.some((r) => (
    r.status === 'approved' &&
    ((r.userId && r.userId.toString() === userId.toString()) || r.email.toLowerCase() === String(email || '').toLowerCase())
  ));
}

async function activateMeetingIfNeeded(call: ICall) {
  if (call.isLive) return;
  call.isLive = true;
  call.callStatus = 'calling';
  call.startedAt = new Date();
}

/**
 * POST /api/calls/start  { conversationId }
 * Idempotent: if a live call already exists for the conversation, the caller
 * joins it instead of creating a duplicate.
 */
export const startCall = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;
  const { conversationId } = req.body;
  if (!conversationId) throw new ApiError(400, 'conversationId is required');

  await assertMember(conversationId, userId);

  const existing = await Call.findOne({ conversationId, isLive: true });
  if (existing) {
    const isMod = existing.moderatorUserId.toString() === userId.toString();
    if (!existing.participants.some((p) => p.userId.toString() === userId.toString() && !p.leftAt)) {
      existing.participants.push({ userId, joinedAt: new Date(), isModerator: isMod, leftAt: null });
      if (existing.callStatus === 'calling') existing.callStatus = 'active';
      await existing.save();
      await emitToConversationMembers(conversationId, 'call:participant-joined', {
        meetingId: existing.meetingId,
        conversationId,
        userId: userId.toString(),
        participantCount: existing.participants.filter((p) => !p.leftAt).length,
      });
    }
    return res.json(
      new ApiResponse(200, { call: existing, jitsi: buildJitsi(existing, crmUser, isMod) }, 'Joined existing call')
    );
  }

  const meetingId = crypto.randomUUID();
  const roomName = `conversation-${conversationId}-${Date.now()}`;

  const call = await Call.create({
    meetingId,
    roomName,
    conversationId,
    initiatedBy: userId,
    moderatorUserId: userId, // caller owns moderator at the app layer + JaaS token
    participants: [{ userId, joinedAt: new Date(), isModerator: true, leftAt: null }],
    callStatus: 'calling',
    isLive: true,
    startedAt: new Date(),
  });

  await emitToConversationMembers(conversationId, 'call:started', {
    meetingId,
    roomName,
    conversationId,
    initiatedBy: userId.toString(),
    moderatorUserId: userId.toString(),
    startedAt: call.startedAt,
    callerName: crmUser.fullName,
  });

  res.status(201).json(new ApiResponse(201, { call, jitsi: buildJitsi(call, crmUser, true) }, 'Call started'));
});

/**
 * POST /api/calls/meeting  { conversationId, title, scheduledAt?, optionalMessage? }
 * Creates a shareable scheduled SupraSpace meeting and posts an invite card to chat.
 */
export const createMeeting = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;
  const { conversationId, title, scheduledAt, optionalMessage } = req.body;
  if (!conversationId) throw new ApiError(400, 'conversationId is required');
  if (!title?.trim()) throw new ApiError(400, 'Meeting title is required');

  const conversation = await assertMember(conversationId, userId);
  const meetingId = crypto.randomUUID();
  const roomName = `meeting-${meetingId}`;
  const meetingLink = buildMeetingLink(meetingId);
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : new Date();

  const call = await Call.create({
    meetingId,
    roomName,
    conversationId,
    initiatedBy: userId,
    moderatorUserId: userId,
    participants: [],
    callStatus: 'scheduled',
    isLive: false,
    title: title.trim(),
    scheduledAt: scheduledDate,
    optionalMessage: optionalMessage?.trim() || '',
    meetingLink,
    allowedDomain: DEFAULT_MEETING_DOMAIN,
    approvedUsers: [],
    admissionRequests: [],
    startedAt: scheduledDate,
  });

  const contentLines = [
    optionalMessage?.trim() || '',
    `${title.trim()}`,
    `Video meeting: ${meetingLink}`,
  ].filter(Boolean);

  const message = await SupraSpaceMessage.create({
    conversationId,
    sender: userId,
    type: 'event',
    content: contentLines.join('\n'),
    event: {
      title: title.trim(),
      description: optionalMessage?.trim() || '',
      location: 'SupraSpace Meeting',
      startTime: scheduledDate,
      endTime: null,
      going: [userId],
      maybe: [],
      declined: [],
    },
    metadata: {
      meeting: {
        meetingId,
        meetingLink,
        title: title.trim(),
        scheduledAt: scheduledDate,
        allowedDomain: DEFAULT_MEETING_DOMAIN,
      },
    },
    readBy: [userId],
  });

  await message.populate('sender', 'fullName username avatar');
  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const messageForClient = message.toObject();
  await emitToConversationMembers(conversationId, 'message:new', { conversationId, message: messageForClient });

  res.status(201).json(new ApiResponse(201, { call, message: messageForClient, meetingLink }, 'Meeting created'));
});

/** GET /api/calls/meeting/:meetingId */
export const getMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { meetingId } = req.params;
  const call = await Call.findOne({ meetingId, callStatus: { $ne: 'ended' } }).lean();
  if (!call) throw new ApiError(404, 'Meeting not found');
  res.json(new ApiResponse(200, { call, meetingLink: call.meetingLink || buildMeetingLink(meetingId) }, 'Meeting found'));
});

/** POST /api/calls/meeting/:meetingId/admission */
export const decideMeetingAdmission = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const { meetingId } = req.params;
  const { userId, email, decision } = req.body;
  if (!['approved', 'denied'].includes(decision)) throw new ApiError(400, 'Invalid admission decision');

  const call = await Call.findOne({ meetingId, callStatus: { $ne: 'ended' } });
  if (!call) throw new ApiError(404, 'Meeting not found');
  if (call.moderatorUserId.toString() !== crmUser._id.toString()) throw new ApiError(403, 'Only the meeting host can approve guests');

  const request = call.admissionRequests.find((r) => (
    (userId && r.userId && r.userId.toString() === String(userId)) ||
    (email && r.email.toLowerCase() === String(email).toLowerCase())
  ));
  if (!request) throw new ApiError(404, 'Admission request not found');

  request.status = decision;
  request.decidedAt = new Date();
  request.decidedBy = crmUser._id;
  if (decision === 'approved' && request.userId && !idIn(call.approvedUsers as any, request.userId)) {
    call.approvedUsers.push(request.userId);
  }
  await call.save();

  await emitToConversationMembers(call.conversationId, 'meeting:admission-updated', {
    meetingId,
    conversationId: call.conversationId.toString(),
    request: {
      userId: request.userId?.toString(),
      name: request.name,
      email: request.email,
      status: request.status,
    },
  });
  try {
    if (request.userId) {
      getIO().to(`user:${request.userId.toString()}`).emit('meeting:admission-updated', {
        meetingId,
        status: request.status,
      });
    }
  } catch { /* best-effort */ }

  res.json(new ApiResponse(200, { call }, `Guest ${decision}`));
});

/** POST /api/calls/join  { meetingId } */
export const joinCall = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;
  const { meetingId } = req.body;
  if (!meetingId) throw new ApiError(400, 'meetingId is required');

  const call = await Call.findOne({ meetingId, callStatus: { $ne: 'ended' } });
  if (!call) throw new ApiError(404, 'No active call for this meeting');

  const conv = await SupraSpaceConversation.findById(call.conversationId).select('members');
  if (!conv) throw new ApiError(404, 'Conversation not found');
  const isConversationMember = idIn(conv.members as any, userId);
  if (!isConversationMember && !isApprovedForMeeting(call, userId, crmUser.email)) {
    const email = String(crmUser.email || crmUser.username || '').toLowerCase();
    const existingRequest = call.admissionRequests.find((r) => (
      (r.userId && r.userId.toString() === userId.toString()) || r.email.toLowerCase() === email
    ));

    if (!existingRequest) {
      call.admissionRequests.push({
        userId,
        name: crmUser.fullName || crmUser.username || 'Guest',
        email,
        status: 'pending',
        requestedAt: new Date(),
        decidedAt: null,
        decidedBy: null,
      });
      await call.save();
      await emitToConversationMembers(call.conversationId, 'meeting:join-requested', {
        meetingId,
        conversationId: call.conversationId.toString(),
        requester: { userId: userId.toString(), name: crmUser.fullName, email },
      });
    }

    return res.status(202).json(new ApiResponse(202, { status: existingRequest?.status || 'pending', meetingId }, 'Waiting for host approval'));
  }

  const isMod = call.moderatorUserId.toString() === userId.toString();
  if (!call.participants.find((p) => p.userId.toString() === userId.toString() && !p.leftAt)) {
    call.participants.push({ userId, joinedAt: new Date(), isModerator: isMod, leftAt: null });
  }
  await activateMeetingIfNeeded(call);
  if (call.callStatus === 'calling') call.callStatus = 'active';
  await call.save();

  await emitToConversationMembers(call.conversationId, 'call:participant-joined', {
    meetingId,
    conversationId: call.conversationId.toString(),
    userId: userId.toString(),
    participantCount: call.participants.filter((p) => !p.leftAt).length,
  });

  res.json(new ApiResponse(200, { call, jitsi: buildJitsi(call, crmUser, isMod) }, 'Joined call'));
});

/**
 * POST /api/calls/end  { meetingId }
 * The participant leaves. The call is terminated (with a "Call ended" system
 * message + server-computed duration) when the moderator or the last
 * participant exits.
 */
export const endCall = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.crmUser!._id;
  const { meetingId } = req.body;
  if (!meetingId) throw new ApiError(400, 'meetingId is required');

  const call = await Call.findOne({ meetingId, isLive: true });
  if (!call) return res.json(new ApiResponse(200, null, 'Call already ended'));

  const p = call.participants.find((x) => x.userId.toString() === userId.toString() && !x.leftAt);
  if (p) p.leftAt = new Date();

  const remaining = call.participants.filter((x) => !x.leftAt);
  const moderatorLeft = call.moderatorUserId.toString() === userId.toString();

  if (moderatorLeft || remaining.length === 0) {
    call.callStatus = 'ended';
    call.isLive = false;
    call.endedAt = new Date();
    call.duration = Math.max(0, Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000));

    const sysMsg = await SupraSpaceMessage.create({
      conversationId: call.conversationId,
      sender: call.initiatedBy,
      type: 'system',
      content: `📞 Call ended · Duration ${formatDuration(call.duration)}`,
      readBy: [],
    });
    call.systemMessageId = sysMsg._id as any;
    await call.save();

    await SupraSpaceConversation.findByIdAndUpdate(call.conversationId, {
      lastMessage: sysMsg._id,
      lastMessageAt: sysMsg.createdAt,
    });

    await sysMsg.populate('sender', 'fullName username avatar');
    await emitToConversationMembers(call.conversationId, 'call:ended', {
      meetingId,
      conversationId: call.conversationId.toString(),
      duration: call.duration,
      durationLabel: formatDuration(call.duration),
    });
    await emitToConversationMembers(call.conversationId, 'message:new', {
      conversationId: call.conversationId.toString(),
      message: sysMsg.toObject(),
    });

    return res.json(new ApiResponse(200, { call }, 'Call ended'));
  }

  await call.save();
  await emitToConversationMembers(call.conversationId, 'call:participant-left', {
    meetingId,
    conversationId: call.conversationId.toString(),
    userId: userId.toString(),
    participantCount: remaining.length,
  });
  res.json(new ApiResponse(200, { call }, 'Left call'));
});

/**
 * GET /api/calls/:conversationId/status
 * Used to rejoin an active call after refresh / reconnect / multi-device.
 */
export const getCallStatus = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;
  const { conversationId } = req.params;
  await assertMember(conversationId, userId);

  const call = await Call.findOne({ conversationId, isLive: true }).populate(
    'participants.userId',
    'fullName username avatar'
  );

  if (!call) return res.json(new ApiResponse(200, null, 'No active call'));

  const isMod = call.moderatorUserId.toString() === userId.toString();
  res.json(new ApiResponse(200, { call, jitsi: buildJitsi(call, crmUser, isMod) }, 'Active call'));
});

export default { startCall, createMeeting, getMeeting, decideMeetingAdmission, joinCall, endCall, getCallStatus };
