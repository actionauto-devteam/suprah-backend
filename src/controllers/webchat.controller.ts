import crypto from 'crypto';
import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import Vehicle from '../models/Vehicle.model';
import Organization from '../models/Organization.model';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import IntakeClaim from '../models/IntakeClaim.model';
import { LEAD_SOURCE } from '../constants/leadSource';
import { emitToOrg } from '../utils/socketEmitter';
import { notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import { createAiAgentTaskAndNotify } from '../utils/aiAgentTask';
import { addLeadNoteAndNotify, shouldSuppressHandoffNoteNotification } from '../utils/leadNote';
import { recordHumanTakeover } from '../utils/aiAutoPause';
import { isWithinSendingHours } from '../utils/sendingWindow';
import logger from '../utils/logger';
import {
  resolveAiAgentSettings,
  processAlexTurn,
  AiAgentTranscriptEntry,
  HISTORY_LIMIT,
} from '../services/aiAgent.service';
import { getRelevantAiCoaching } from '../services/aiAgentCoaching.service';
import { AttentionCheck, beginAiAttentionCheck, finishAiAttentionCheck, screenAiHumanAttention,
  canSendAiReply, assertAiReplyAllowed, claimAiGeneration, claimAiReplyDispatch } from '../services/aiHumanAttention.service';

const AI_AGENT_ACTOR_ID = 'ai-agent';

const MAX_MESSAGE_LENGTH = 1000;
const MAX_VISITOR_MESSAGES_PER_HOUR = 80;
const SYNC_LIMIT = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_EXPIRED_MESSAGE = 'This chat session has expired. Please start a new chat.';

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const tokensMatch = (expectedHash: string, token: string) => {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const firstNameOf = (name?: string) => (name || '').trim().split(/\s+/)[0] || '';

const serializeForStaff = (message: any) => ({
  _id: String(message._id),
  leadId: String(message.leadId),
  sessionId: String(message.sessionId),
  direction: message.direction,
  body: message.body,
  createdAt: message.createdAt,
  sentBy: message.sentBy ? { userId: message.sentBy.userId, name: message.sentBy.name } : undefined,
  channel: 'webchat',
});

const serializeForVisitor = (message: any) => ({
  _id: String(message._id),
  fromVisitor: message.direction === 'inbound',
  body: message.body,
  createdAt: message.createdAt,
  agentName:
    message.direction === 'outbound' ? firstNameOf(message.sentBy?.name) || undefined : undefined,
});

function actor(req: Request) {
  const u: any = (req as any).user || (req as any).crmUser || {};
  return {
    userId: String(u._id || u.id || ''),
    name:
      u.name ||
      u.fullName ||
      [u.firstName, u.lastName].filter(Boolean).join(' ') ||
      u.email ||
      'Team member',
  };
}

async function loadSession(req: Request) {
  const { sessionId } = req.params;
  const token = String(req.body?.token || '');

  if (!mongoose.isValidObjectId(sessionId) || !token) {
    throw new ApiError(404, SESSION_EXPIRED_MESSAGE);
  }

  const session = await WebChatSession.findById(sessionId).select('+tokenHash');
  if (!session || !tokensMatch(session.tokenHash, token)) {
    throw new ApiError(404, SESSION_EXPIRED_MESSAGE);
  }

  return session;
}

function validateMessageBody(raw: unknown): string {
  const body = String(raw || '').trim();
  if (!body) throw new ApiError(400, 'Please type a message');
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(400, `Messages are limited to ${MAX_MESSAGE_LENGTH} characters`);
  }
  return body;
}

function isOrgWebchatEnabled(metadata: any): boolean {
  return process.env.WEBCHAT_ENABLED !== 'false' && metadata?.webchatEnabled !== false;
}

async function resolveDealerName(organizationId: any): Promise<string> {
  try {
    const org = await Organization.findById(organizationId).select('name').lean();
    return org?.name || 'Your Dealership';
  } catch {
    return 'Your Dealership';
  }
}

async function buildWebchatTranscript(sessionId: any): Promise<AiAgentTranscriptEntry[]> {
  const messages = await WebChatMessage.find({ sessionId, aiDispatchPending: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  return messages.reverse().map((m: any): AiAgentTranscriptEntry => {
    if (m.direction === 'inbound') return { from: 'customer', body: m.body };
    if (m.sentBy?.userId === AI_AGENT_ACTOR_ID) return { from: 'ai', body: m.body };
    return { from: 'staff', staffName: m.sentBy?.name, body: m.body };
  });
}

/** Fire-and-forget: generates and sends Alex's next reply for this session,
 *  if the org has Alex enabled and this conversation isn't paused. Called
 *  after every inbound visitor message (first message and every follow-up),
 *  never awaited by the caller so LLM latency never blocks the visitor's
 *  own HTTP response. */
async function triggerWebchatAiReply(session: any, check: AttentionCheck, body: string): Promise<void> {
  try {
    const { enabled, agentName } = await resolveAiAgentSettings(session.organizationId);
    if (!enabled) { await finishAiAttentionCheck(check); return; }
    if (!(await screenAiHumanAttention({ ...check, leadId: String(session.leadId), body, agentName, phone: session.visitorPhone }))) return;

    const claimed = await claimAiGeneration(check);
    if (!claimed) return;

    try {
      const lead = await Lead.findOne({ _id: session.leadId, organizationId: session.organizationId })
        .select('firstName vehicle assignedTo phone').lean();
      const [transcript, repliesSentToday, priorAiReplyCount, dealerName, coaching] = await Promise.all([
        buildWebchatTranscript(session._id),
        WebChatMessage.countDocuments({
          sessionId: session._id,
          'sentBy.userId': AI_AGENT_ACTOR_ID,
          aiDispatchPending: { $ne: true },
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        }),
        WebChatMessage.countDocuments({
          sessionId: session._id,
          'sentBy.userId': AI_AGENT_ACTOR_ID,
          aiDispatchPending: { $ne: true },
        }),
        resolveDealerName(session.organizationId),
        getRelevantAiCoaching({ organizationId: String(session.organizationId), channel: 'webchat' }),
      ]);

      const vehicleInterest = (lead as any)?.vehicle
        ? [(lead as any).vehicle.year, (lead as any).vehicle.make, (lead as any).vehicle.model]
            .filter(Boolean)
            .join(' ')
        : undefined;

      await processAlexTurn({
        organizationId: String(session.organizationId),
        leadId: String(session.leadId),
        channel: 'webchat',
        sessionId: String(session._id),
        agentName,
        dealerName,
        customerFirstName: firstNameOf(session.visitorName) || (lead as any)?.firstName,
        leadVehicleInterest: vehicleInterest,
        phone: session.visitorPhone || (lead as any)?.phone,
        transcript,
        repliesSentToday,
        isFirstReply: priorAiReplyCount === 0,
        coachingNotes: coaching.notes,
        coachingRuleIds: coaching.ids,
        coachingRules: coaching.rules,
        send: async (text: string) => {
          await assertAiReplyAllowed(check);
          const message = await WebChatMessage.create({
            organizationId: session.organizationId,
            sessionId: session._id,
            leadId: session.leadId,
            direction: 'outbound',
            body: text,
            sentBy: { userId: AI_AGENT_ACTOR_ID, name: agentName },
            aiDispatchPending: true,
          });
          try { await claimAiReplyDispatch(check); }
          catch (error) {
            await WebChatMessage.deleteOne({ _id: message._id, organizationId: session.organizationId });
            throw error;
          }
          await WebChatMessage.updateOne({ _id: message._id, organizationId: session.organizationId },
            { $set: { aiDispatchPending: false } });
          const now = new Date();
          await Promise.all([
            WebChatSession.updateOne({ _id: session._id, organizationId: session.organizationId }, { $set: { lastMessageAt: now } }),
            Lead.updateOne({ _id: session.leadId, organizationId: session.organizationId }, { $set: { 'followUp.lastRepResponseAt': now } }),
          ]);
          const payload = serializeForStaff(message);
          emitToOrg(String(session.organizationId), 'webchat:message', {
            leadId: String(session.leadId),
            message: payload,
          });
          return { messageId: String(message._id) };
        },
        notifyHandoff: async (reason) => {
          const assignedTo = (lead as any)?.assignedTo;
          const taskResult = await createAiAgentTaskAndNotify({
            organizationId: String(session.organizationId),
            leadId: String(session.leadId),
            channel: 'webchat',
            question: reason,
            agentName,
            customerName: session.visitorName || 'A customer',
            assignedTo: assignedTo ? String(assignedTo) : null,
          });
          try {
            const mentionedUserIds = assignedTo ? [String(assignedTo)] : [];
            let mentionedGroupIds: string[] = [];
            if (!assignedTo) {
              const org = await Organization.findById(session.organizationId).select('metadata').lean();
              const fallbackGroupId = (org?.metadata as any)?.aiHandoffFallbackGroupId;
              if (fallbackGroupId) mentionedGroupIds = [String(fallbackGroupId)];
            }
            await addLeadNoteAndNotify({
              organizationId: String(session.organizationId),
              leadId: String(session.leadId),
              text: reason || 'Needs human follow-up',
              authorType: 'ai',
              authorName: agentName,
              mentionedUserIds,
              mentionedGroupIds,
              suppressNotification: shouldSuppressHandoffNoteNotification(assignedTo, Boolean(taskResult?.notified)),
            });
          } catch (err) {
            logger.error({ err }, '[AiAgent] Failed to write handoff note');
          }
        },
        notifyMilestone: async (note) => {
          try {
            await addLeadNoteAndNotify({
              organizationId: String(session.organizationId),
              leadId: String(session.leadId),
              text: note,
              authorType: 'ai',
              authorName: agentName,
              milestone: true,
            });
          } catch (err) {
            logger.error({ err }, '[AiAgent] Failed to write milestone note');
          }
        },
        onCapExceeded: async () => {
          await WebChatSession.updateOne(
            { _id: session._id, organizationId: session.organizationId },
            { $set: { aiPausedAt: new Date(), aiPausedBy: { userId: 'system', name: 'Suprah AI' } } },
          );
          emitToOrg(String(session.organizationId), 'webchat:ai_paused', {
            leadId: String(session.leadId),
            paused: true,
            pausedBy: 'Suprah AI',
          });
        },
        isPausedNow: async () => {
          return !(await canSendAiReply(check));
        },
      });
    } finally {
      await WebChatSession.updateOne({ _id: session._id, organizationId: session.organizationId,
        aiGeneratingAt: claimed.aiGeneratingAt }, { $unset: { aiGeneratingAt: '' } });
    }
  } catch (err) {
    logger.error({ err }, '[Webchat] Alex trigger failed');
  }
}

export const getPublicConfig = asyncHandler(async (req: Request, res: Response) => {
  const { vehicleId, orgKey } = req.query;
  let orgId: any = null;

  if (vehicleId && mongoose.isValidObjectId(String(vehicleId))) {
    const vehicle = await Vehicle.findById(String(vehicleId)).select('organizationId').lean();
    orgId = vehicle?.organizationId;
  } else if (orgKey) {
    const organization = await Organization.findOne({ slug: String(orgKey), status: 'active' })
      .select('_id')
      .lean();
    orgId = organization?._id;
  }

  if (!orgId) {
    return res.json(
      new ApiResponse(200, { enabled: false, greeting: '', withinHours: true }, 'Chat is not available for this dealership'),
    );
  }

  const organization = await Organization.findById(orgId).select('metadata').lean();
  const metadata = (organization?.metadata as any) || {};

  res.json(
    new ApiResponse(
      200,
      {
        enabled: isOrgWebchatEnabled(metadata),
        greeting: metadata.webchatGreeting || '',
        withinHours: isWithinSendingHours(),
      },
      'Chat configuration',
    ),
  );
});

export const startSession = asyncHandler(async (req: Request, res: Response) => {
  if (process.env.WEBCHAT_ENABLED === 'false') {
    throw new ApiError(503, 'Chat is currently unavailable. Please call us instead.');
  }

  const { vehicleId, orgKey, name, email, phone, message, pageUrl } = req.body || {};
  const clientRequestId = String(req.body?.clientRequestId || '').trim().slice(0, 80);

  const visitorName = String(name || '').trim().slice(0, 80);
  const visitorEmail = String(email || '').trim().toLowerCase().slice(0, 120);
  const visitorPhone = String(phone || '').trim().slice(0, 30);

  if (!visitorName) throw new ApiError(400, 'Please tell us your name');
  if (!visitorEmail && !visitorPhone) {
    throw new ApiError(400, 'Please add a phone number or email so we can reach you');
  }
  if (visitorEmail && !EMAIL_PATTERN.test(visitorEmail)) {
    throw new ApiError(400, 'Please enter a valid email address');
  }
  if (visitorPhone && visitorPhone.replace(/\D/g, '').length < 7) {
    throw new ApiError(400, 'Please enter a valid phone number');
  }
  const firstMessage = validateMessageBody(message);

  let vehicle: any = null;
  let orgId: any = null;

  if (vehicleId) {
    if (!mongoose.isValidObjectId(vehicleId)) throw new ApiError(404, 'Vehicle not found');
    vehicle = await Vehicle.findById(vehicleId).lean();
    if (!vehicle) throw new ApiError(404, 'Vehicle not found');
    orgId = vehicle.organizationId;
  } else if (orgKey) {
    const organization = await Organization.findOne({ slug: String(orgKey), status: 'active' })
      .select('_id')
      .lean();
    orgId = organization?._id;
  }

  if (!orgId) throw new ApiError(404, 'Chat is not available for this dealership');

  const organizationDoc = await Organization.findById(orgId).select('metadata').lean();
  if (!isOrgWebchatEnabled(organizationDoc?.metadata)) {
    throw new ApiError(503, 'Chat is currently unavailable. Please call us instead.');
  }

  const systemUser = await User.findOne({
    organizationId: orgId,
    role: { $in: ['admin', 'employee'] },
  })
    .sort({ role: 1 })
    .select('_id')
    .lean();

  if (!systemUser) {
    throw new ApiError(400, 'This dealership is not yet set up to receive chats');
  }

  if (clientRequestId) {
    const claimResult = await IntakeClaim.findOneAndUpdate(
      { organizationId: orgId, kind: 'webchat_session', claimKey: clientRequestId },
      {
        $setOnInsert: {
          organizationId: orgId,
          kind: 'webchat_session',
          claimKey: clientRequestId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
      { new: true, upsert: true, includeResultMetadata: true },
    );

    if (claimResult.lastErrorObject?.updatedExisting) {
      const existingLeadId = claimResult.value?.leadId;
      const existingSession = existingLeadId
        ? await WebChatSession.findOne({ leadId: existingLeadId }).sort({ createdAt: -1 })
        : null;

      if (existingSession) {
        const replayToken = crypto.randomBytes(24).toString('hex');
        existingSession.tokenHash = hashToken(replayToken);
        await existingSession.save();

        const priorMessages = await WebChatMessage.find({ sessionId: existingSession._id, aiDispatchPending: { $ne: true } }).sort({
          createdAt: 1,
        });

        return res.status(201).json(
          new ApiResponse(
            201,
            {
              sessionId: String(existingSession._id),
              token: replayToken,
              messages: priorMessages.map(serializeForVisitor),
            },
            'Chat started',
          ),
        );
      }

      throw new ApiError(409, 'This request is already being processed.');
    }
  }

  const [firstName, ...restOfName] = visitorName.split(/\s+/);
  const vehicleInterest = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
    : undefined;

  const lead = await Lead.create({
    organizationId: orgId,
    createdBy: (systemUser as any)._id,
    firstName: firstName || 'Unknown',
    lastName: restOfName.join(' '),
    email: visitorEmail || undefined,
    phone: visitorPhone || undefined,
    vehicle: vehicle
      ? {
          year: vehicle.year ? String(vehicle.year) : undefined,
          make: vehicle.make,
          model: vehicle.model,
          stock: vehicle.stockNumber,
          trim: vehicle.trim,
        }
      : undefined,
    vehicleId: vehicle?._id,
    location: vehicle?.dealerCity || undefined,
    comments: firstMessage,
    source: LEAD_SOURCE.WEBSITE_CHAT,
    channel: 'webchat',
    status: 'New',
  });

  const token = crypto.randomBytes(24).toString('hex');
  const session = await WebChatSession.create({
    organizationId: String(orgId),
    leadId: lead._id,
    tokenHash: hashToken(token),
    visitorName,
    visitorEmail: visitorEmail || undefined,
    visitorPhone: visitorPhone || undefined,
    vehicleId: vehicle?._id,
    pageUrl: pageUrl ? String(pageUrl).slice(0, 500) : undefined,
  });

  const messageId = new mongoose.Types.ObjectId();
  const check = await beginAiAttentionCheck({ organizationId: String(orgId), channel: 'webchat',
    targetId: String(session._id), messageId: String(messageId) });
  const chatMessage = await WebChatMessage.create({
    _id: messageId,
    organizationId: String(orgId),
    sessionId: session._id,
    leadId: lead._id,
    direction: 'inbound',
    body: firstMessage,
  });

  if (clientRequestId) {
    await IntakeClaim.updateOne(
      { organizationId: orgId, kind: 'webchat_session', claimKey: clientRequestId },
      { $set: { leadId: lead._id } },
    );
  }

  emitToOrg(String(orgId), 'lead:new', lead.toObject());
  emitToOrg(String(orgId), 'webchat:message', {
    leadId: String(lead._id),
    message: serializeForStaff(chatMessage),
  });

  const { title, message: notificationMessage } = notificationTemplates.new_lead({
    customerName: visitorName,
    source: LEAD_SOURCE.WEBSITE_CHAT,
    vehicleInterest,
  });
  notifyOrgAdmins(String(orgId), 'new_lead', title, notificationMessage, {
    leadId: String(lead._id),
    customerName: visitorName,
    source: LEAD_SOURCE.WEBSITE_CHAT,
    channel: 'webchat',
  }).catch(() => undefined);

  logger.info({ leadId: lead._id, sessionId: session._id }, 'Website chat started');

  triggerWebchatAiReply(session, check, firstMessage).catch(() => undefined);

  res.status(201).json(
    new ApiResponse(
      201,
      {
        sessionId: String(session._id),
        token,
        messages: [serializeForVisitor(chatMessage)],
      },
      'Chat started',
    ),
  );
});

export const sendVisitorMessage = asyncHandler(async (req: Request, res: Response) => {
  const session = await loadSession(req);
  const body = validateMessageBody(req.body?.message);

  const recentCount = await WebChatMessage.countDocuments({
    sessionId: session._id,
    direction: 'inbound',
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (recentCount >= MAX_VISITOR_MESSAGES_PER_HOUR) {
    throw new ApiError(429, 'You have reached the message limit for now. Please call us or try again later.');
  }

  const messageId = new mongoose.Types.ObjectId();
  const check = await beginAiAttentionCheck({ organizationId: String(session.organizationId), channel: 'webchat',
    targetId: String(session._id), messageId: String(messageId) });
  const message = await WebChatMessage.create({
    _id: messageId,
    organizationId: session.organizationId,
    sessionId: session._id,
    leadId: session.leadId,
    direction: 'inbound',
    body,
  });

  const now = new Date();
  await Promise.all([
    WebChatSession.updateOne({ _id: session._id }, { $set: { lastMessageAt: now } }),
    Lead.updateOne(
      { _id: session.leadId },
      { $set: { 'followUp.lastCustomerActivityAt': now, isRead: false } },
    ),
  ]);

  emitToOrg(session.organizationId, 'webchat:message', {
    leadId: String(session.leadId),
    message: serializeForStaff(message),
  });
  emitToOrg(session.organizationId, 'lead:update', { leadId: String(session.leadId) });

  triggerWebchatAiReply(session, check, body).catch(() => undefined);

  res.status(201).json(new ApiResponse(201, { message: serializeForVisitor(message) }, 'Message sent'));
});

export const syncVisitorMessages = asyncHandler(async (req: Request, res: Response) => {
  const session = await loadSession(req);

  const filter: Record<string, unknown> = { sessionId: session._id, aiDispatchPending: { $ne: true } };
  const after = req.body?.after ? new Date(String(req.body.after)) : null;
  if (after && !isNaN(after.getTime())) filter.createdAt = { $gt: after };

  const messages = await WebChatMessage.find(filter).sort({ createdAt: 1 }).limit(SYNC_LIMIT).lean();
  const TYPING_WINDOW_MS = 6000;
  const staffTyping = Boolean(
    session.staffTypingAt && Date.now() - new Date(session.staffTypingAt).getTime() < TYPING_WINDOW_MS,
  );

  res.json(
    new ApiResponse(200, { messages: messages.map(serializeForVisitor), staffTyping }, 'Messages synced'),
  );
});

export const pingTyping = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;

  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');

  await WebChatSession.updateOne(
    { leadId, organizationId: orgId },
    { $set: { staffTypingAt: new Date() } },
  );

  res.json(new ApiResponse(200, null, 'Typing signal sent'));
});

export const getLeadWebChat = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;

  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');

  const lead = await Lead.findOne({ _id: leadId, organizationId: orgId }).select('_id').lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  const [messages, session] = await Promise.all([
    WebChatMessage.find({ leadId, organizationId: orgId, aiDispatchPending: { $ne: true } }).sort({ createdAt: 1 }).limit(500).lean(),
    WebChatSession.findOne({ leadId, organizationId: orgId })
      .select('aiPausedAt aiPausedBy aiAutoPausedUntil')
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        messages: messages.map(serializeForStaff),
        aiPausedAt: session?.aiPausedAt || null,
        aiPausedBy: session?.aiPausedBy || null,
        aiAutoPausedUntil: session?.aiAutoPausedUntil || null,
      },
      'Web chat fetched',
    ),
  );
});

export const sendStaffMessage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;
  const body = validateMessageBody(req.body?.body);

  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');

  const session = await WebChatSession.findOne({ leadId, organizationId: orgId });
  if (!session) throw new ApiError(404, 'No web chat found for this lead');

  const staff = actor(req);
  if (!staff.userId) throw new ApiError(401, 'Please authenticate');
  const message = await WebChatMessage.create({
    organizationId: orgId,
    sessionId: session._id,
    leadId: session.leadId,
    direction: 'outbound',
    body,
    sentBy: { userId: staff.userId, name: staff.name },
  });

  const now = new Date();
  await Promise.all([
    WebChatSession.updateOne({ _id: session._id }, { $set: { lastMessageAt: now } }),
    Lead.updateOne({ _id: session.leadId }, { $set: { 'followUp.lastRepResponseAt': now } }),
  ]);

  await recordHumanTakeover({
    kind: 'webchat',
    organizationId: orgId,
    sessionId: session._id,
    leadId: session.leadId,
  });

  const payload = serializeForStaff(message);
  emitToOrg(orgId, 'webchat:message', { leadId: String(session.leadId), message: payload });

  res.status(201).json(new ApiResponse(201, { message: payload }, 'Message sent'));
});

export const pauseWebchatAi = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');

  const staff = actor(req);
  if (!staff.userId) throw new ApiError(401, 'Please authenticate');
  const session = await WebChatSession.findOneAndUpdate(
    { leadId, organizationId: orgId },
    {
      $set: { aiPausedAt: new Date(), aiPausedBy: { userId: staff.userId, name: staff.name } },
      $unset: { aiAutoPausedUntil: '' },
      $inc: { aiResponseVersion: 1 },
    },
    { new: true },
  );
  if (!session) throw new ApiError(404, 'No web chat found for this lead');

  emitToOrg(orgId, 'webchat:ai_paused', { leadId: String(leadId), paused: true, pausedBy: staff.name });
  res.json(new ApiResponse(200, { paused: true }, 'AI agent paused for this conversation'));
});

export const resumeWebchatAi = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  if (!actor(req).userId) throw new ApiError(401, 'Please authenticate');

  const session = await WebChatSession.findOneAndUpdate(
    { leadId, organizationId: orgId },
    { $unset: { aiPausedAt: '', aiPausedBy: '', aiAutoPausedUntil: '', aiHumanAttention: '', aiAttentionPendingIds: '' },
      $inc: { aiResponseVersion: 1 } },
    { new: true },
  );
  if (!session) throw new ApiError(404, 'No web chat found for this lead');

  emitToOrg(orgId, 'webchat:ai_paused', { leadId: String(leadId), paused: false });
  res.json(new ApiResponse(200, { paused: false }, 'AI agent resumed for this conversation'));
});
