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

const idIn = (arr: any[], id: any) => (arr || []).map(String).includes(id.toString());

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

/** POST /api/calls/join  { meetingId } */
export const joinCall = asyncHandler(async (req: Request, res: Response) => {
  const crmUser = req.crmUser!;
  const userId = crmUser._id;
  const { meetingId } = req.body;
  if (!meetingId) throw new ApiError(400, 'meetingId is required');

  const call = await Call.findOne({ meetingId, isLive: true });
  if (!call) throw new ApiError(404, 'No active call for this meeting');

  await assertMember(call.conversationId.toString(), userId);

  const isMod = call.moderatorUserId.toString() === userId.toString();
  if (!call.participants.find((p) => p.userId.toString() === userId.toString() && !p.leftAt)) {
    call.participants.push({ userId, joinedAt: new Date(), isModerator: isMod, leftAt: null });
  }
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

export default { startCall, joinCall, endCall, getCallStatus };
