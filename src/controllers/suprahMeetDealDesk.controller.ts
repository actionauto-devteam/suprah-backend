import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Joi from 'joi';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import Meeting, { IMeeting } from '../models/Meeting.model';
import CrmUser from '../models/CrmUser.model';
import { deleteChimeMeeting } from '../services/suprahMeetAws.service';
import { claimHostMeetingEnd } from '../services/suprahMeetLifecycle.service';
import { readGuestPass, signGuest } from '../services/suprahMeetGuestPass.service';
import {
  assertAttemptAllowed, clearFailures, dealDeskUrls, hashRoomPassword, isActiveParticipant, liveQueue,
  notifyHostCustomerQueued, recordFailure, roomPresence, serializeHostRoom, serializePublicRoom,
  validateRoomPassword, verifyRoomPassword,
} from '../services/suprahMeetDealDesk.service';

/*
 * Deal Desk — dedicated customer-facing rooms inside Suprah Meet.
 *
 * A Deal Desk room is an ordinary Suprah Meet meeting document with
 * `roomType: 'dealdesk'` and `visibility: 'private'`. Being private means the
 * existing waiting room, admit/deny, guest join, presence, recording and AI
 * summary all apply unchanged. On top of that this controller adds:
 *   • a per-room hashed password,
 *   • a public, per-organization listing of open rooms,
 *   • a password-checked "join the line" step that issues a Deal Desk guest
 *     pass (the only kind of pass the guest endpoints accept for these rooms),
 *   • a live queue view for the rep.
 * Admit / decline reuse POST /meetings/:code/waiting/:userId.
 */

const MAX_OPEN_ROOMS_PER_HOST = 25;
const TITLE_MIN = 3;
const QUEUE_TOUCH_MS = 10_000;

function requireCrmUser(req: Request) {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization. Contact your administrator.');
  }
  return user;
}

const isManager = (user: any) => user.role === 'admin' || user.role === 'manager';
const normCode = (raw: unknown) => String(raw || '').trim().toUpperCase();

function cleanTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
  if (title.length < TITLE_MIN) {
    throw new ApiError(400, 'Give the room a clear title (at least 3 characters) so customers can pick the right one.');
  }
  return title;
}

const cleanDescription = (raw: unknown) =>
  typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 280) : '';

const makeCode = () => `MEET-${crypto.randomInt(1000, 10000)}`;
async function createRoomDocument(base: Record<string, any>): Promise<IMeeting> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await Meeting.create({ ...base, code: makeCode() });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new ApiError(500, 'Could not allocate a meeting code. Please try again.');
}

async function findHostRoom(req: Request, opts: { withPassword?: boolean } = {}) {
  const user = requireCrmUser(req);
  const q = Meeting.findOne({ organizationId: user.organizationId, code: normCode(req.params.code), roomType: 'dealdesk' });
  if (opts.withPassword) q.select('+dealDesk.passwordHash');
  const meeting = await q;
  if (!meeting) throw new ApiError(404, 'Deal Desk room not found.');
  if (String(meeting.hostCrmUserId) !== String(user._id)) {
    throw new ApiError(403, 'Only the rep who created this Deal Desk room can manage it.');
  }
  return { user, meeting };
}

/* ═══ Management (CRM auth) ═══════════════════════════════════════════════ */

// POST /api/crm/meet/deal-desk/rooms   Body: { title, password, description? }
const createRoom = asyncHandler(async (req: Request, res: Response) => {
  const user = requireCrmUser(req);
  const title = cleanTitle(req.body?.title);
  const password = validateRoomPassword(req.body?.password);
  const description = cleanDescription(req.body?.description);

  const openCount = await Meeting.countDocuments({
    organizationId: user.organizationId, hostCrmUserId: user._id, roomType: 'dealdesk',
    status: { $in: ['scheduled', 'live'] }, 'dealDesk.archivedAt': null,
  });
  if (openCount >= MAX_OPEN_ROOMS_PER_HOST) {
    throw new ApiError(409, `You already have ${MAX_OPEN_ROOMS_PER_HOST} Deal Desk rooms. Close one before creating another.`);
  }

  const meeting = await createRoomDocument({
    organizationId: user.organizationId,
    title,
    hostCrmUserId: user._id,
    invitees: [], inviteAll: false, inviteDepartments: [],
    invitationNotificationPending: false,
    visibility: 'private',
    roomType: 'dealdesk',
    // Same as an instant meeting: a reservation until the rep enters it.
    status: 'scheduled',
    participants: [],
    dealDesk: {
      description,
      passwordHash: await hashRoomPassword(password),
      passwordUpdatedAt: new Date(),
      isOpen: true,
      archivedAt: null,
    },
  });
  res.status(201).json(new ApiResponse(201, {
    room: serializeHostRoom(meeting.toObject(), user),
    ...dealDeskUrls(String(user.organizationId)),
  }, 'Deal Desk room created'));
});

// GET /api/crm/meet/deal-desk/rooms   (?scope=all → admins/managers see the whole org)
const listRooms = asyncHandler(async (req: Request, res: Response) => {
  const user = requireCrmUser(req);
  const orgWide = String(req.query.scope || '') === 'all' && isManager(user);
  const filter: Record<string, any> = {
    organizationId: user.organizationId, roomType: 'dealdesk', 'dealDesk.archivedAt': null,
    ...(orgWide ? {} : { hostCrmUserId: user._id }),
  };
  const [active, ended] = await Promise.all([
    Meeting.find({ ...filter, status: { $in: ['scheduled', 'live'] } }).sort({ createdAt: -1 }).limit(100).lean(),
    Meeting.find({ ...filter, status: 'ended' }).sort({ endedAt: -1 }).limit(20).lean(),
  ]);
  const hostIds = [...new Set([...active, ...ended].map((m) => String(m.hostCrmUserId)))];
  const hosts = new Map<string, any>((await CrmUser.find({ _id: { $in: hostIds }, organizationId: user.organizationId })
    .select('fullName').lean()).map((h: any) => [String(h._id), h]));
  const now = Date.now();
  res.set('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, {
    rooms: active.map((m) => serializeHostRoom(m, hosts.get(String(m.hostCrmUserId)), now)),
    ended: ended.map((m) => serializeHostRoom(m, hosts.get(String(m.hostCrmUserId)), now)),
    canViewAll: isManager(user),
    scope: orgWide ? 'all' : 'mine',
    selfCrmUserId: String(user._id),
    serverTime: new Date(now).toISOString(),
    ...dealDeskUrls(String(user.organizationId)),
  }, 'Deal Desk rooms'));
});

// PATCH /api/crm/meet/deal-desk/rooms/:code   Body: { title?, description?, password?, isOpen? }
const updateRoom = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findHostRoom(req);
  if (meeting.status === 'ended') throw new ApiError(409, 'This room has ended. Reopen it to use it again.');
  const { title, description, password, isOpen } = req.body ?? {};
  const set: Record<string, any> = {};
  if (title !== undefined) set.title = cleanTitle(title);
  if (description !== undefined) set['dealDesk.description'] = cleanDescription(description);
  if (password !== undefined && password !== '') {
    set['dealDesk.passwordHash'] = await hashRoomPassword(validateRoomPassword(password));
    set['dealDesk.passwordUpdatedAt'] = new Date();
  }
  if (isOpen !== undefined) set['dealDesk.isOpen'] = Boolean(isOpen);
  if (Object.keys(set).length === 0) throw new ApiError(400, 'Nothing to update.');
  const result = await Meeting.updateOne({ _id: meeting._id, organizationId: user.organizationId, status: { $ne: 'ended' } }, { $set: set });
  if (result.matchedCount === 0) throw new ApiError(409, 'This room just ended. Refresh and try again.');
  const fresh = await Meeting.findById(meeting._id).lean();
  res.json(new ApiResponse(200, { room: serializeHostRoom(fresh, user) },
    set['dealDesk.passwordHash'] ? 'Room updated — the new password applies to customers who join from now on' : 'Room updated'));
});

// POST /api/crm/meet/deal-desk/rooms/:code/reopen   — fresh room from an ended one
const reopenRoom = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findHostRoom(req, { withPassword: true });
  if (meeting.status !== 'ended') throw new ApiError(409, 'This room is still open.');
  const next = await createRoomDocument({
    organizationId: user.organizationId,
    title: meeting.title,
    hostCrmUserId: user._id,
    invitees: [], inviteAll: false, inviteDepartments: [],
    invitationNotificationPending: false,
    visibility: 'private', roomType: 'dealdesk', status: 'scheduled', participants: [],
    dealDesk: {
      description: meeting.dealDesk?.description ?? '',
      passwordHash: meeting.dealDesk?.passwordHash,
      passwordUpdatedAt: meeting.dealDesk?.passwordUpdatedAt ?? new Date(),
      isOpen: true, archivedAt: null, reopenedFrom: meeting.code,
    },
  });
  // The ended session stays in history (recording / summary) but leaves the Deal Desk list.
  await Meeting.updateOne({ _id: meeting._id }, { $set: { 'dealDesk.archivedAt': new Date() } });
  res.status(201).json(new ApiResponse(201, { room: serializeHostRoom(next.toObject(), user) }, 'Room reopened with the same title and password'));
});

// DELETE /api/crm/meet/deal-desk/rooms/:code   — close the room
const closeRoom = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting: found } = await findHostRoom(req);
  let meeting: IMeeting = found;
  if (meeting.status === 'ended') {
    await Meeting.updateOne({ _id: meeting._id }, { $set: { 'dealDesk.archivedAt': new Date(), 'dealDesk.isOpen': false } });
    return res.json(new ApiResponse(200, { closed: true }, 'Room removed from Deal Desk'));
  }
  const othersInRoom = meeting.participants.filter((p: any) =>
    isActiveParticipant(p) && !(p.crmUserId && String(p.crmUserId) === String(user._id)));
  if (othersInRoom.length > 0) {
    throw new ApiError(409, 'Someone is still in this room. End the meeting from the room first, or stop accepting customers.');
  }
  if (meeting.recording?.status === 'recording') {
    throw new ApiError(409, 'This room is recording. Stop the recording from the room before closing it.');
  }
  // Customers still in line see "This room has closed" on their next poll.
  const declineWaiting = {
    $set: { 'waiting.$[w].status': 'denied', 'waiting.$[w].respondedAt': new Date(), 'dealDesk.isOpen': false, 'dealDesk.archivedAt': new Date() },
  };
  const arrayFilters = [{ 'w.status': 'waiting' }];

  if (meeting.status === 'scheduled' && meeting.participants.length === 0 && !meeting.chimeMeetingId) {
    await Meeting.deleteOne({ _id: meeting._id, status: 'scheduled' });
    return res.json(new ApiResponse(200, { closed: true, deleted: true }, 'Room closed'));
  }
  const claimed = await claimHostMeetingEnd(meeting, user._id);
  meeting = claimed.meeting;
  if (meeting.chimeMeetingId) await deleteChimeMeeting(meeting.chimeMeetingId).catch(() => {});
  await Meeting.updateOne({ _id: meeting._id }, declineWaiting, { arrayFilters });
  res.json(new ApiResponse(200, { closed: true }, 'Room closed'));
});

/* ═══ Public (no auth) ════════════════════════════════════════════════════ */

function orgIdParam(req: Request): string {
  const org = String(req.params.org || '').trim();
  if (!mongoose.isValidObjectId(org)) throw new ApiError(404, 'This Deal Desk page does not exist.');
  return org;
}

const PUBLIC_FIELDS = 'code title status hostCrmUserId participants waiting removedParticipantIds dealDesk.description dealDesk.isOpen dealDesk.archivedAt organizationId createdAt';

async function organizationName(org: string): Promise<string | null> {
  // The Organization model is not part of Suprah Meet; read its name if registered.
  const Org = mongoose.models.Organization;
  if (!Org) return null;
  try {
    const doc: any = await Org.findById(org).select('name displayName').lean();
    return doc?.displayName || doc?.name || null;
  } catch { return null; }
}

// GET /api/crm/meet/deal-desk/public/:org/rooms
const publicListRooms = asyncHandler(async (req: Request, res: Response) => {
  const org = orgIdParam(req);
  const rooms = await Meeting.find({
    organizationId: org, roomType: 'dealdesk', status: { $in: ['scheduled', 'live'] },
    'dealDesk.isOpen': true, 'dealDesk.archivedAt': null,
  }).select(PUBLIC_FIELDS).sort({ createdAt: 1 }).limit(100).lean();
  const hosts = new Map<string, any>((await CrmUser.find({ _id: { $in: rooms.map((r) => r.hostCrmUserId) }, organizationId: org })
    .select('fullName avatar').lean()).map((h: any) => [String(h._id), h]));
  const now = Date.now();
  res.set('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, {
    organizationName: await organizationName(org),
    rooms: rooms.map((r) => serializePublicRoom(r, hosts.get(String(r.hostCrmUserId)), now)),
    serverTime: new Date(now).toISOString(),
  }, 'Deal Desk rooms'));
});

const emailSchema = Joi.string().email({ tlds: { allow: false } }).max(120);

// POST /api/crm/meet/deal-desk/public/:org/rooms/:code/enter   Body: { name, email?, password }
const publicEnterRoom = asyncHandler(async (req: Request, res: Response) => {
  const org = orgIdParam(req);
  const code = normCode(req.params.code);
  const limiterKey = `${req.ip}:${org}:${code}`;
  assertAttemptAllowed(limiterKey);

  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (name.length < 2) throw new ApiError(400, 'Please enter your name (at least 2 characters).');
  const emailRaw = String(req.body?.email || '').trim().toLowerCase();
  if (emailRaw && emailSchema.validate(emailRaw).error) throw new ApiError(400, 'That email address does not look right.');
  const email = emailRaw || null;
  const password = req.body?.password;
  if (typeof password !== 'string' || !password.trim()) throw new ApiError(400, 'Enter the room password your representative gave you.');

  const meeting = await Meeting.findOne({ organizationId: org, code, roomType: 'dealdesk' })
    .select(`${PUBLIC_FIELDS} +dealDesk.passwordHash`);
  if (!meeting || meeting.status === 'ended' || meeting.dealDesk?.archivedAt) {
    throw new ApiError(404, 'This room is no longer available. Pick another room from the list.');
  }

  // Validate against THIS room's hash only — another room's password never matches.
  const ok = await verifyRoomPassword(password, meeting.dealDesk?.passwordHash);
  if (!ok) {
    const left = recordFailure(limiterKey);
    return res.status(403).json({
      statusCode: 403, success: false, data: { attemptsLeft: left },
      message: left > 0
        ? `That password is not correct for this room. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'Too many incorrect passwords for this room. Try again in a few minutes.',
    });
  }
  clearFailures(limiterKey);

  // Keep the same identity (and place in line) across refreshes on this device.
  const previous = readGuestPass(req);
  const guestId = previous && previous.organizationId === org && previous.code === code && previous.dealDesk
    ? previous.guestId : 'g' + crypto.randomBytes(8).toString('hex');

  if (((meeting as any).removedParticipantIds ?? []).includes(`guest:${guestId}`)) {
    throw new ApiError(409, 'The representative removed you from this room.');
  }
  const existing = (meeting.waiting ?? []).find((w: any) => w.guestId === guestId);
  if (existing?.status === 'denied') {
    throw new ApiError(409, 'The representative is not able to take you in this room. Please choose another room.');
  }
  if (!existing && !meeting.dealDesk?.isOpen) {
    throw new ApiError(409, 'This room is not accepting new customers right now. Please choose another room.');
  }

  const now = new Date();
  const displayName = `${name} (guest)`;
  let isNew = false;
  if (!existing) {
    const pushed = await Meeting.updateOne(
      { _id: meeting._id, status: { $ne: 'ended' }, 'waiting.guestId': { $ne: guestId } },
      { $push: { waiting: {
        fullName: displayName, status: 'waiting', requestedAt: now, lastSeenAt: now,
        isGuest: true, guestId, guestEmail: email || undefined, source: 'dealdesk',
      } } });
    isNew = pushed.modifiedCount > 0;
  } else {
    const back = existing.status === 'left';
    await Meeting.updateOne(
      { _id: meeting._id, 'waiting.guestId': guestId },
      { $set: {
        'waiting.$.fullName': displayName, 'waiting.$.lastSeenAt': now,
        ...(email ? { 'waiting.$.guestEmail': email } : {}),
        ...(back ? { 'waiting.$.status': 'waiting', 'waiting.$.requestedAt': now } : {}),
      } });
    isNew = back;
  }
  if (isNew) notifyHostCustomerQueued(meeting, name);

  const guestToken = signGuest({ code: meeting.code, guestId, name, email, organizationId: org, dealDesk: true });
  res.json(new ApiResponse(200, {
    guestToken, code: meeting.code, title: meeting.title,
    state: existing?.status === 'admitted' ? 'admitted' : 'waiting',
  }, 'You are in line'));
});

function queueSnapshot(m: any, guestId: string) {
  const now = Date.now();
  const queue = liveQueue(m, now);
  const index = queue.findIndex((w) => w.guestId === guestId);
  const { state: roomState, hostInRoom } = roomPresence(m, now);
  return { position: index >= 0 ? index + 1 : null, waitingCount: queue.length, roomState, repInRoom: hostInRoom };
}

// GET /api/crm/meet/deal-desk/public/:org/rooms/:code/queue   (Deal Desk guest pass)
// Never 401s: an invalid pass answers { state: 'expired' } so the page simply asks again.
const publicQueueStatus = asyncHandler(async (req: Request, res: Response) => {
  const org = orgIdParam(req);
  const code = normCode(req.params.code);
  res.set('Cache-Control', 'no-store');
  const pass = readGuestPass(req);
  if (!pass || !pass.dealDesk || pass.code !== code || pass.organizationId !== org) {
    return res.json(new ApiResponse(200, { state: 'expired' }, 'Enter the room again'));
  }
  const m = await Meeting.findOne({ organizationId: org, code, roomType: 'dealdesk' }).select(PUBLIC_FIELDS).lean();
  if (!m || m.status === 'ended') return res.json(new ApiResponse(200, { state: 'ended' }, 'Room ended'));
  if (((m as any).removedParticipantIds ?? []).includes(`guest:${pass.guestId}`)) {
    return res.json(new ApiResponse(200, { state: 'denied' }, 'Removed'));
  }
  const entry: any = (m.waiting ?? []).find((w: any) => w.guestId === pass.guestId);
  if (!entry) return res.json(new ApiResponse(200, { state: 'expired' }, 'Enter the room again'));

  if (entry.status === 'waiting' && (!entry.lastSeenAt || Date.now() - new Date(entry.lastSeenAt).getTime() > QUEUE_TOUCH_MS)) {
    await Meeting.updateOne({ _id: m._id, 'waiting.guestId': pass.guestId }, { $set: { 'waiting.$.lastSeenAt': new Date() } })
      .catch((error) => logger.error({ error }, '[SuprahMeet] Deal Desk queue heartbeat failed'));
    entry.lastSeenAt = new Date(); // count this poll toward the live queue below
  }
  const state = entry.status === 'denied' ? (m.dealDesk?.archivedAt ? 'closed' : 'denied') : entry.status;
  res.json(new ApiResponse(200, { state, title: m.title, code: m.code, ...queueSnapshot(m, pass.guestId) }, 'Queue status'));
});

// POST /api/crm/meet/deal-desk/public/:org/rooms/:code/leave   (Deal Desk guest pass)
const publicLeaveQueue = asyncHandler(async (req: Request, res: Response) => {
  const org = orgIdParam(req);
  const code = normCode(req.params.code);
  const pass = readGuestPass(req);
  if (pass && pass.dealDesk && pass.code === code && pass.organizationId === org) {
    await Meeting.updateOne(
      { organizationId: org, code, roomType: 'dealdesk', waiting: { $elemMatch: { guestId: pass.guestId, status: 'waiting' } } },
      { $set: { 'waiting.$.status': 'left', 'waiting.$.respondedAt': new Date() } });
  }
  res.json(new ApiResponse(200, {}, 'Left the line'));
});

export default {
  createRoom, listRooms, updateRoom, reopenRoom, closeRoom,
  publicListRooms, publicEnterRoom, publicQueueStatus, publicLeaveQueue,
};
