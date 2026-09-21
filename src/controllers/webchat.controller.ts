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
import { emitToOrg } from '../utils/socketEmitter';
import { notifyOrgAdmins } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import logger from '../utils/logger';

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

export const startSession = asyncHandler(async (req: Request, res: Response) => {
  if (process.env.WEBCHAT_ENABLED === 'false') {
    throw new ApiError(503, 'Chat is currently unavailable. Please call us instead.');
  }

  const { vehicleId, orgKey, name, email, phone, message, pageUrl } = req.body || {};

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
    comments: firstMessage,
    source: 'Website Chat',
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

  const chatMessage = await WebChatMessage.create({
    organizationId: String(orgId),
    sessionId: session._id,
    leadId: lead._id,
    direction: 'inbound',
    body: firstMessage,
  });

  emitToOrg(String(orgId), 'lead:new', lead.toObject());
  emitToOrg(String(orgId), 'webchat:message', {
    leadId: String(lead._id),
    message: serializeForStaff(chatMessage),
  });

  const { title, message: notificationMessage } = notificationTemplates.new_lead({
    customerName: visitorName,
    source: 'Website Chat',
    vehicleInterest,
  });
  notifyOrgAdmins(String(orgId), 'new_lead', title, notificationMessage, {
    leadId: String(lead._id),
    customerName: visitorName,
    source: 'Website Chat',
    channel: 'webchat',
  }).catch(() => undefined);

  logger.info({ leadId: lead._id, sessionId: session._id }, 'Website chat started');

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

  const message = await WebChatMessage.create({
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

  res.status(201).json(new ApiResponse(201, { message: serializeForVisitor(message) }, 'Message sent'));
});

export const syncVisitorMessages = asyncHandler(async (req: Request, res: Response) => {
  const session = await loadSession(req);

  const filter: Record<string, unknown> = { sessionId: session._id };
  const after = req.body?.after ? new Date(String(req.body.after)) : null;
  if (after && !isNaN(after.getTime())) filter.createdAt = { $gt: after };

  const messages = await WebChatMessage.find(filter).sort({ createdAt: 1 }).limit(SYNC_LIMIT).lean();

  res.json(new ApiResponse(200, { messages: messages.map(serializeForVisitor) }, 'Messages synced'));
});

export const getLeadWebChat = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;

  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');

  const lead = await Lead.findOne({ _id: leadId, organizationId: orgId }).select('_id').lean();
  if (!lead) throw new ApiError(404, 'Lead not found');

  const messages = await WebChatMessage.find({ leadId, organizationId: orgId })
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();

  res.json(new ApiResponse(200, { messages: messages.map(serializeForStaff) }, 'Web chat fetched'));
});

export const sendStaffMessage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId);
  const { leadId } = req.params;
  const body = validateMessageBody(req.body?.body);

  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');

  const session = await WebChatSession.findOne({ leadId, organizationId: orgId });
  if (!session) throw new ApiError(404, 'No web chat found for this lead');

  const staff = actor(req);
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

  const payload = serializeForStaff(message);
  emitToOrg(orgId, 'webchat:message', { leadId: String(session.leadId), message: payload });

  res.status(201).json(new ApiResponse(201, { message: payload }, 'Message sent'));
});
