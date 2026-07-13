import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Call, { ICall } from '../models/Call.model';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import User from '../models/User.model';
import appointmentService from '../services/appointment.service';
import { getIO } from '../socket/supraspace.socket';
import { generateJaasToken, jaasRoomName, jaasConfigured, JAAS_DOMAIN } from '../services/jaas.service';
import config from '../config';

const idIn = (arr: any[], id: any) => (arr || []).map(String).includes(id.toString());
const DEFAULT_MEETING_DOMAIN = 'actionautoutah.com';
const SUPRA_MEETING_DEPARTMENTS = [
  'SalesAndFinance',
  'Accounting',
  'Recon',
  'Marketing',
  'OnlineTeam',
  'WebDevTeam',
  'WholesaleTeam',
  'BuyingTeam',
  'OperationsTeam',
  'LotTechTeam',
  'FundingTeam',
  'ProspectsTeam',
  'PriceCheckTeam',
];

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
 * POST /api/calls/meeting  { conversationId?, title, scheduledAt?, optionalMessage? }
 * Creates a shareable scheduled SupraSpace meeting. When conversationId is
 * provided, it also posts an invite card to chat.
 */
export const createMeeting = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;
  const { conversationId, title, scheduledAt, optionalMessage } = req.body;
  if (!title?.trim()) throw new ApiError(400, 'Meeting title is required');

  const conversation = conversationId ? await assertMember(conversationId, userId) : null;
  const meetingId = crypto.randomUUID();
  const roomName = `meeting-${meetingId}`;
  const meetingLink = buildMeetingLink(meetingId);
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : new Date();

  const callPayload: any = {
    meetingId,
    roomName,
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
  };
  if (conversationId) {
    callPayload.conversationId = conversationId;
  } else {
    callPayload.conversationId = new mongoose.Types.ObjectId();
    callPayload.isStandaloneMeeting = true;
  }

  const call = await Call.create(callPayload);

  if (!conversationId || !conversation) {
    return res.status(201).json(new ApiResponse(201, { call, meetingLink }, 'Meeting link created'));
  }

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

/**
 * POST /api/calls/meeting/schedule
 * Body: { title, description?, scheduledAt, endTime?, department }
 * Creates a standalone meeting link and adds it to the CRM appointment calendar.
 */
export const scheduleMeeting = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id.toString();
  const orgId = crmUser.organizationId?.toString();
  const { title, description, scheduledAt, endTime, department } = req.body;

  if (!orgId) throw new ApiError(400, 'Organization is required');
  if (!title?.trim()) throw new ApiError(400, 'Meeting title is required');
  if (!scheduledAt) throw new ApiError(400, 'Meeting date and time is required');

  const targetDepartment = String(department || 'all');
  if (targetDepartment !== 'all' && !SUPRA_MEETING_DEPARTMENTS.includes(targetDepartment)) {
    throw new ApiError(400, 'Invalid department');
  }

  const start = new Date(scheduledAt);
  if (Number.isNaN(start.getTime())) throw new ApiError(400, 'Invalid meeting date and time');
  if (start.getTime() <= Date.now()) throw new ApiError(400, 'Meeting must be scheduled in the future');

  const end = endTime ? new Date(endTime) : new Date(start.getTime() + 30 * 60 * 1000);
  if (Number.isNaN(end.getTime()) || end <= start) throw new ApiError(400, 'End time must be after start time');

  const meetingId = crypto.randomUUID();
  const roomName = `meeting-${meetingId}`;
  const meetingLink = buildMeetingLink(meetingId);

  const call = await Call.create({
    meetingId,
    roomName,
    conversationId: new mongoose.Types.ObjectId(),
    isStandaloneMeeting: true,
    initiatedBy: userId,
    moderatorUserId: userId,
    participants: [],
    callStatus: 'scheduled',
    isLive: false,
    title: title.trim(),
    scheduledAt: start,
    optionalMessage: description?.trim() || '',
    meetingLink,
    allowedDomain: DEFAULT_MEETING_DOMAIN,
    approvedUsers: [],
    admissionRequests: [],
    startedAt: start,
  });

  const crmUsers = await CrmUser.find({
    organizationId: orgId,
    isActive: true,
    isOffboarded: { $ne: true },
    isSystem: { $ne: true },
  }).select('_id email').lean();

  let targetCrmUserIds = crmUsers.map((u: any) => u._id.toString());
  if (targetDepartment !== 'all') {
    const emails = crmUsers.map((u: any) => String(u.email || '').toLowerCase()).filter(Boolean);
    const mainUsers = await User.find({
      email: { $in: emails },
      'personalInfo.department': targetDepartment,
    }).select('email').lean();
    const deptEmails = new Set(mainUsers.map((u: any) => String(u.email || '').toLowerCase()));
    targetCrmUserIds = crmUsers
      .filter((u: any) => deptEmails.has(String(u.email || '').toLowerCase()))
      .map((u: any) => u._id.toString());
  }

  const participantIds = Array.from(new Set([userId, ...targetCrmUserIds]));
  const appointmentDescription = [
    description?.trim(),
    `Meeting link: ${meetingLink}`,
    targetDepartment === 'all' ? 'Audience: All departments' : `Department: ${targetDepartment}`,
  ].filter(Boolean).join('\n\n');

  const appointment = await appointmentService.createAppointment(userId, orgId, {
    title: title.trim(),
    description: appointmentDescription,
    startTime: start,
    endTime: end,
    location: 'Suprah Meeting',
    type: 'video',
    entryType: 'appointment',
    participants: participantIds,
    meetingLink,
    notes: targetDepartment === 'all' ? 'Scheduled for all departments' : `Scheduled for ${targetDepartment}`,
  });

  res.status(201).json(new ApiResponse(201, {
    call,
    appointment,
    meetingLink,
    participantCount: participantIds.length,
    department: targetDepartment,
  }, 'Meeting scheduled in Suprah Calendar'));
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

  if (!call.isStandaloneMeeting) {
    await emitToConversationMembers(call.conversationId, 'meeting:admission-updated', {
      meetingId,
      conversationId: String(call.conversationId),
      request: {
        userId: request.userId?.toString(),
        name: request.name,
        email: request.email,
        status: request.status,
      },
    });
  }
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

  const conv = !call.isStandaloneMeeting
    ? await SupraSpaceConversation.findById(call.conversationId).select('members')
    : null;
  if (!call.isStandaloneMeeting && !conv) throw new ApiError(404, 'Conversation not found');
  const isConversationMember = conv ? idIn(conv.members as any, userId) : false;
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
      if (!call.isStandaloneMeeting) {
        await emitToConversationMembers(call.conversationId, 'meeting:join-requested', {
          meetingId,
          conversationId: String(call.conversationId),
          requester: { userId: userId.toString(), name: crmUser.fullName, email },
        });
      } else {
        try {
          getIO().to(`user:${call.moderatorUserId.toString()}`).emit('meeting:join-requested', {
            meetingId,
            requester: { userId: userId.toString(), name: crmUser.fullName, email },
          });
        } catch { /* best-effort */ }
      }
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

  if (!call.isStandaloneMeeting) {
    await emitToConversationMembers(call.conversationId, 'call:participant-joined', {
      meetingId,
      conversationId: String(call.conversationId),
      userId: userId.toString(),
      participantCount: call.participants.filter((p) => !p.leftAt).length,
    });
  }

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

    if (call.isStandaloneMeeting) {
      await call.save();
      return res.json(new ApiResponse(200, { call }, 'Call ended'));
    }

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
  if (!call.isStandaloneMeeting) {
    await emitToConversationMembers(call.conversationId, 'call:participant-left', {
      meetingId,
      conversationId: call.conversationId.toString(),
      userId: userId.toString(),
      participantCount: remaining.length,
    });
  }
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

/**
 * GET /api/calls/my-active-call
 * Returns the caller's current active call and whether they may record it.
 * Polled by the tray-app every 10 seconds.
 */
export const getMyActiveCall = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;

  const call = await Call.findOne({
    isLive: true,
    $or: [
      { 'participants.userId': userId },
      { moderatorUserId: userId },
    ],
  }).lean();

  if (!call) {
    return res.json(new ApiResponse(200, null, 'No active call'));
  }

  const isHost = call.moderatorUserId.toString() === userId.toString();
  const isActiveParticipant = call.participants.some((p) => (
    p.userId.toString() === userId.toString() && !p.leftAt
  ));
  const canRecord = isHost || isActiveParticipant;

  res.json(new ApiResponse(200, {
    meetingId: call.meetingId,
    conversationId: String(call.conversationId),
    title: call.title || null,
    startedAt: call.startedAt,
    isHost,
    canRecord,
    isRecording: call.isRecording ?? false,
    recordingStartedAt: call.recordingStartedAt ?? null,
    participantCount: call.participants.filter((p) => !p.leftAt).length,
  }, 'Active call'));
});

/**
 * POST /api/calls/meeting/:meetingId/grant-recording  { userId }
 * Host grants recording permission to a specific participant.
 */
export const grantRecording = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const { meetingId } = req.params;
  const { userId } = req.body;
  if (!userId) throw new ApiError(400, 'userId is required');

  const call = await Call.findOne({ meetingId, isLive: true });
  if (!call) throw new ApiError(404, 'No active call for this meeting');
  if (call.moderatorUserId.toString() !== crmUser._id.toString()) {
    throw new ApiError(403, 'Only the host can grant recording permission');
  }

  const targetId = new (require('mongoose').Types.ObjectId)(userId);
  if (!call.recordingAllowedUsers.map(String).includes(userId)) {
    call.recordingAllowedUsers.push(targetId);
    await call.save();
  }

  try {
    getIO().to(`user:${userId}`).emit('call:recording-granted', { meetingId });
  } catch { /* best-effort */ }

  res.json(new ApiResponse(200, { meetingId, userId }, 'Recording permission granted'));
});

/**
 * DELETE /api/calls/meeting/:meetingId/grant-recording  { userId }
 * Host revokes recording permission from a participant.
 */
export const revokeRecording = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const { meetingId } = req.params;
  const { userId } = req.body;
  if (!userId) throw new ApiError(400, 'userId is required');

  const call = await Call.findOne({ meetingId, isLive: true });
  if (!call) throw new ApiError(404, 'No active call for this meeting');
  if (call.moderatorUserId.toString() !== crmUser._id.toString()) {
    throw new ApiError(403, 'Only the host can revoke recording permission');
  }

  call.recordingAllowedUsers = call.recordingAllowedUsers.filter(
    (id) => id.toString() !== userId
  );
  await call.save();

  try {
    getIO().to(`user:${userId}`).emit('call:recording-revoked', { meetingId });
  } catch { /* best-effort */ }

  res.json(new ApiResponse(200, { meetingId, userId }, 'Recording permission revoked'));
});

/**
 * POST /api/calls/meeting/:meetingId/recording/start
 * Host (or granted user) starts recording — triggers tray and notifies all participants.
 */
export const startCallRecording = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const { meetingId } = req.params;

  const call = await Call.findOne({ meetingId, isLive: true });
  if (!call) throw new ApiError(404, 'No active call for this meeting');

  const userId = crmUser._id.toString();
  const isHost = call.moderatorUserId.toString() === userId;
  const isActiveParticipant = call.participants.some((p) => p.userId.toString() === userId && !p.leftAt);
  if (!isHost && !isActiveParticipant) throw new ApiError(403, 'Only active call participants can record');

  if (call.isRecording) {
    return res.json(new ApiResponse(200, null, 'Already recording'));
  }

  call.isRecording = true;
  call.recordingStartedAt = new Date();
  await call.save();

  const payload = {
    meetingId,
    recordingStartedAt: call.recordingStartedAt.toISOString(),
    startedBy: userId,
  };

  const io = getIO();
  // Notify all participants in the conversation (awareness badge)
  if (!call.isStandaloneMeeting) io.to(`conv:${call.conversationId}`).emit('call:recording-started', payload);
  // Trigger the recorder's tray to start Electron recording.
  io.to(`user:${userId}`).emit('tray:start-recording', payload);

  res.json(new ApiResponse(200, payload, 'Recording started'));
});

/**
 * POST /api/calls/meeting/:meetingId/recording/stop
 * Host (or granted user) stops recording.
 */
export const stopCallRecording = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const { meetingId } = req.params;

  const call = await Call.findOne({ meetingId, isLive: true });
  if (!call) throw new ApiError(404, 'No active call for this meeting');

  const userId = crmUser._id.toString();
  const isHost = call.moderatorUserId.toString() === userId;
  const isActiveParticipant = call.participants.some((p) => p.userId.toString() === userId && !p.leftAt);
  if (!isHost && !isActiveParticipant) throw new ApiError(403, 'Only active call participants can stop recording');

  call.isRecording = false;
  call.recordingStartedAt = null;
  await call.save();

  const payload = { meetingId };
  const io = getIO();
  if (!call.isStandaloneMeeting) io.to(`conv:${call.conversationId}`).emit('call:recording-stopped', payload);
  io.to(`user:${userId}`).emit('tray:stop-recording', payload);

  res.json(new ApiResponse(200, payload, 'Recording stopped'));
});

export default {
  startCall,
  createMeeting,
  scheduleMeeting,
  getMeeting,
  decideMeetingAdmission,
  joinCall,
  endCall,
  getCallStatus,
  getMyActiveCall,
  grantRecording,
  revokeRecording,
  startCallRecording,
  stopCallRecording,
};
