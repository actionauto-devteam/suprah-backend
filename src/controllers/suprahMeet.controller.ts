import { Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Meeting, { IMeeting } from '../models/Meeting.model';
import CrmUser from '../models/CrmUser.model';
import {
  createChimeMeeting, getChimeMeeting, createChimeAttendee, deleteChimeMeeting,
  startRecordingPipelines, stopRecordingPipelines, findConcatenatedVideoKey, presignGet,
} from '../services/suprahMeetAws.service';
import {
  startTranscription, getTranscriptionStatus, readTranscriptText, generateSummary,
} from '../services/suprahMeetAI.service';
import { mailConfigured, sendRecordingEmail } from '../services/suprahMeetMail.service';

const COMPANY_TZ = 'America/Denver'; // Mountain time — MDT/MST with automatic DST
const MAX_SERIES_SESSIONS = 30;

const makeCode = () => `MEET-${crypto.randomInt(1000, 10000)}`;

/** Log the real AWS error server-side, then throw a descriptive ApiError. */
function wrapAws<T>(p: Promise<T>, what: string): Promise<T> {
  return p.catch((err: any) => {
    console.error(`[SuprahMeet] ${what} — AWS error:`, {
      name: err?.name,
      message: err?.message,
      httpStatus: err?.$metadata?.httpStatusCode,
    });
    const detail = err?.message || err?.name || 'unknown AWS error';
    throw new ApiError(502, `${what} failed on AWS: ${detail}`);
  });
}

/**
 * Same logging, but returns a payload we send DIRECTLY with res.json(),
 * bypassing the global error middleware (which serializes some errors
 * as {} and hides the reason from the client).
 */
function awsFailurePayload(err: any, what: string) {
  console.error(`[SuprahMeet] ${what} — AWS error:`, {
    name: err?.name,
    message: err?.message,
    httpStatus: err?.$metadata?.httpStatusCode,
  });
  const detail = err?.message || err?.name || 'unknown AWS error';
  return {
    statusCode: 502,
    success: false,
    message: `${what} failed on AWS: ${detail}`,
    data: null,
  };
}

function requireCrmUser(req: Request) {
  const user = req.crmUser;
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.organizationId) {
    throw new ApiError(403, 'Your account is not linked to any organization. Contact your administrator.');
  }
  return user;
}

async function findOrgMeeting(req: Request): Promise<{ user: any; meeting: IMeeting }> {
  const user = requireCrmUser(req);
  const code = String(req.params.code || '').trim().toUpperCase();
  const meeting = await Meeting.findOne({ organizationId: user.organizationId, code });
  if (!meeting) throw new ApiError(404, 'Meeting not found. Check the code and try again.');
  return { user, meeting };
}

function canControl(user: any, meeting: IMeeting): boolean {
  return (
    meeting.hostCrmUserId.toString() === user._id.toString() ||
    user.role === 'admin' || user.role === 'manager'
  );
}

/** May this user enter the room without waiting? */
function isAllowedIn(user: any, meeting: IMeeting): boolean {
  // Public meetings (the default) are open to everyone in the org — the
  // waiting room only guards meetings explicitly marked private.
  if ((meeting as any).visibility !== 'private') return true;
  const uid = user._id.toString();
  if (meeting.hostCrmUserId.toString() === uid) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (meeting.inviteAll) return true;
  if (meeting.invitees.some((id) => id.toString() === uid)) return true;
  // Reconnect: anyone who has been in this meeting before may come back.
  if (meeting.participants.some((p) => p.crmUserId && p.crmUserId.toString() === uid)) return true;
  return ((meeting as any).waiting ?? []).some(
    (w: any) => w.crmUserId && w.crmUserId.toString() === uid && w.status === 'admitted'
  );
}

/** Minutes offset from UTC for America/Denver at a given instant (-360 MDT, -420 MST). */
function denverOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: COMPANY_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    p.hour === '24' ? 0 : Number(p.hour), Number(p.minute), Number(p.second)
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "YYYY-MM-DDTHH:mm" interpreted as Mountain wall time (MDT/MST, DST-aware) → UTC Date. */
function mdtWallToUtc(wall: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) {
    throw new ApiError(400, 'Scheduled times must be "YYYY-MM-DDTHH:mm" (Mountain time).');
  }
  // Treat the wall string as UTC first, then correct by Denver's real offset at
  // that instant; the second pass settles wall times near a DST switchover.
  let utc = new Date(Date.parse(`${wall}:00.000Z`));
  for (let i = 0; i < 2; i++) {
    const offset = denverOffsetMinutes(utc);
    utc = new Date(Date.parse(`${wall}:00.000Z`) - offset * 60_000);
  }
  return utc;
}

/** Create one meeting document, retrying on code collisions. */
async function createOne(base: Record<string, any>): Promise<IMeeting> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await Meeting.create({ ...base, code: makeCode() });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new ApiError(500, 'Could not allocate a meeting code. Please try again.');
}

/**
 * Resolve tagged people + departments to one deduped, org-scoped invitee list.
 * Departments are expanded to their members up front so visibility, alerts,
 * and reminders all keep working off `invitees` unchanged.
 */
async function resolveAudience(user: any, invitees: any, inviteDepartments: any) {
  const inviteeIds = Array.isArray(invitees)
    ? invitees.filter((id: any) => mongoose.isValidObjectId(id)).slice(0, 200)
    : [];
  const directInvitees = inviteeIds.length
    ? (await CrmUser.find({ _id: { $in: inviteeIds }, organizationId: user.organizationId })
        .select('_id').lean()).map((u) => u._id)
    : [];

  const deptKeys = Array.isArray(inviteDepartments)
    ? inviteDepartments
        .filter((d: any) => typeof d === 'string' && d.trim())
        .map((d: string) => d.trim())
        .slice(0, 50)
    : [];
  const deptMembers = deptKeys.length
    ? (await CrmUser.find({
        organizationId: user.organizationId,
        isActive: true,
        isSystem: { $ne: true },
        department: { $in: deptKeys },
      }).select('_id').lean()).map((u) => u._id)
    : [];

  const merged = new Map<string, mongoose.Types.ObjectId>();
  [...directInvitees, ...deptMembers].forEach((id) => merged.set(id.toString(), id));
  return { inviteeList: [...merged.values()], deptKeys };
}

// ── POST /api/crm/meet/meetings ─────────────────────────────────────────────
// Body: { title, invitees[], inviteAll, inviteDepartments[],
//         scheduledAt?: "YYYY-MM-DDTHH:mm",           ← single session
//         occurrences?: ["YYYY-MM-DDTHH:mm", ...] }   ← recurring series
const createMeeting = asyncHandler(async (req: Request, res: Response) => {
  const user = requireCrmUser(req);
  const { title, scheduledAt, occurrences, invitees, inviteAll, inviteDepartments, visibility } = req.body ?? {};

  const cleanTitle = typeof title === 'string' && title.trim()
    ? title.trim().slice(0, 120) : 'Instant meeting';

  // Collect requested wall times (0 = instant meeting).
  let walls: string[] = [];
  if (Array.isArray(occurrences) && occurrences.length > 0) {
    walls = occurrences.map((w: any) => String(w)).slice(0, MAX_SERIES_SESSIONS);
  } else if (scheduledAt) {
    walls = [String(scheduledAt)];
  }
  const scheduledDates = walls
    .map(mdtWallToUtc)
    .filter((d) => d.getTime() >= Date.now() - 60_000)
    .sort((a, b) => a.getTime() - b.getTime());
  if (walls.length > 0 && scheduledDates.length === 0) {
    throw new ApiError(400, 'All the selected times are in the past (MDT). Pick future times.');
  }

  const { inviteeList, deptKeys } = await resolveAudience(user, invitees, inviteDepartments);

  const base = {
    organizationId: user.organizationId,
    title: cleanTitle,
    hostCrmUserId: user._id,
    invitees: inviteeList,
    inviteAll: Boolean(inviteAll),
    inviteDepartments: deptKeys,
    // Public (default): anyone in the org with the code joins right away.
    // Private: join-by-code users go through the waiting room.
    visibility: visibility === 'private' ? 'private' : 'public',
    participants: [],
  };

  // Instant meeting
  if (scheduledDates.length === 0) {
    const meeting = await createOne({ ...base, status: 'live', startedAt: new Date() });
    return res.status(201).json(new ApiResponse(201, serializeMeeting(meeting), 'Meeting created'));
  }

  // Scheduled — one document per session; >1 sessions share a seriesId.
  // Each session gets its own code, recording, AI summary, and reminder.
  const seriesId = scheduledDates.length > 1 ? crypto.randomUUID() : null;
  const created: IMeeting[] = [];
  for (const when of scheduledDates) {
    created.push(await createOne({
      ...base, status: 'scheduled', scheduledAt: when, seriesId: seriesId ?? undefined,
    }));
  }

  res.status(201).json(new ApiResponse(201, {
    ...serializeMeeting(created[0]),
    seriesCount: created.length,
    meetings: created.map(serializeMeeting),
  }, created.length > 1 ? `Series scheduled — ${created.length} sessions` : 'Meeting scheduled'));
});

// ── DELETE /api/crm/meet/meetings/:code (?series=1 removes the whole series) ─
const deleteMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can delete this meeting.');
  }
  if (meeting.status === 'live') {
    throw new ApiError(400, 'This meeting is live — end it instead of deleting it.');
  }
  if (meeting.status === 'ended') {
    throw new ApiError(400, 'Ended meetings are kept for their recordings and summaries.');
  }

  const wholeSeries = String(req.query.series || '') === '1' && meeting.seriesId;
  const result = wholeSeries
    ? await Meeting.deleteMany({
        organizationId: user.organizationId,
        seriesId: meeting.seriesId,
        status: 'scheduled', // never touch sessions that already ran
      })
    : await Meeting.deleteOne({ _id: meeting._id });

  res.json(new ApiResponse(200, { deletedCount: result.deletedCount ?? 0 },
    wholeSeries ? 'Series deleted' : 'Meeting deleted'));
});

// ── External guests ─────────────────────────────────────────────────────────
// Guests join with a shareable link (/meet/<code>) — no Suprah account. They
// get a signed "guest pass" (JWT) that scopes them to ONE meeting code. Public
// meetings admit them directly; private meetings put them in the waiting room,
// where the host admits/denies exactly like internal join-by-code users.
const GUEST_SECRET =
  process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'suprah-meet-guest-dev-secret';

interface GuestPass {
  guest: true; code: string; guestId: string;
  name: string; email: string | null; organizationId: string;
}
const signGuest = (p: Omit<GuestPass, 'guest'>) =>
  jwt.sign({ guest: true, ...p }, GUEST_SECRET, { expiresIn: '12h' });
function verifyGuest(req: Request): GuestPass {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw) throw new ApiError(401, 'Missing guest pass.');
  try {
    const p = jwt.verify(raw, GUEST_SECRET) as any;
    if (!p?.guest || !p?.guestId || !p?.code) throw new Error('not a guest pass');
    return p as GuestPass;
  } catch {
    throw new ApiError(401, 'Your guest pass is invalid or expired. Re-enter your name to get a new one.');
  }
}
// NOTE: codes are unique per organization; the platform currently runs a
// single org, so a global lookup is safe. Revisit if multi-org goes live.
const findMeetingByCodePublic = (code: string) =>
  Meeting.findOne({ code: code.trim().toUpperCase() });

const pubParticipants = (meeting: IMeeting) =>
  meeting.participants.map((p: any) => ({
    crmUserId: p.crmUserId ? p.crmUserId.toString() : `guest:${p.guestId}`,
    fullName: p.fullName,
    avatar: p.avatar ?? null,
    role: p.role,
    isGuest: Boolean(p.isGuest),
  }));

// POST /api/crm/meet/guest/:code/request   Body: { name, email? }   (public)
const guestRequest = asyncHandler(async (req: Request, res: Response) => {
  const meeting = await findMeetingByCodePublic(String(req.params.code || ''));
  if (!meeting) throw new ApiError(404, 'No meeting found for that link.');
  if (meeting.status === 'ended') {
    return res.json(new ApiResponse(200, { ended: true }, 'Meeting already ended'));
  }
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (name.length < 2) throw new ApiError(400, 'Please enter your name (at least 2 characters).');
  const email = String(req.body?.email || '').trim().slice(0, 120) || null;

  // Reuse the same guest identity across refreshes when the browser resends its pass.
  let guestId: string | null = null;
  try { guestId = verifyGuest(req).guestId; } catch { /* first visit — mint a new identity */ }
  if (!guestId) guestId = 'g' + crypto.randomBytes(8).toString('hex');

  const guestToken = signGuest({
    code: meeting.code, guestId, name, email,
    organizationId: meeting.organizationId.toString(),
  });
  const live = meeting.status === 'live';

  if ((meeting as any).visibility !== 'private') {
    return res.json(new ApiResponse(200,
      { admitted: true, live, guestToken, title: meeting.title }, 'Admitted'));
  }
  const waiting: any[] = (meeting as any).waiting ?? ((meeting as any).waiting = []);
  const entry = waiting.find((w) => w.guestId === guestId);
  if (entry?.status === 'denied') {
    return res.json(new ApiResponse(200, { denied: true, guestToken }, 'Declined by the host'));
  }
  if (entry?.status === 'admitted') {
    return res.json(new ApiResponse(200,
      { admitted: true, live, guestToken, title: meeting.title }, 'Admitted'));
  }
  if (!entry) {
    waiting.push({
      fullName: `${name} (guest)`, status: 'waiting', requestedAt: new Date(),
      isGuest: true, guestId, guestEmail: email || undefined,
    });
    await meeting.save();
  }
  res.json(new ApiResponse(200, { waiting: true, guestToken, title: meeting.title }, 'Waiting for the host'));
});

// POST /api/crm/meet/guest/:code/join   (guest pass required)
const guestJoin = asyncHandler(async (req: Request, res: Response) => {
  const g = verifyGuest(req);
  const meeting = await findMeetingByCodePublic(String(req.params.code || ''));
  if (!meeting) throw new ApiError(404, 'No meeting found for that link.');
  if (g.code !== meeting.code) throw new ApiError(401, 'This guest pass is for a different meeting.');
  if (meeting.status === 'ended') throw new ApiError(410, 'This meeting has already ended.');
  // Guests can never START a meeting — only join one that is live.
  if (meeting.status === 'scheduled') {
    throw new ApiError(409, "This meeting hasn't started yet. You'll join automatically once the host starts it.");
  }
  if ((meeting as any).visibility === 'private') {
    const entry = (((meeting as any).waiting ?? []) as any[]).find((w) => w.guestId === g.guestId);
    if (!entry || entry.status !== 'admitted') {
      throw new ApiError(403, 'The host has not admitted you to this meeting yet.');
    }
  }

  let chimeMeeting = meeting.chimeMeetingId ? await getChimeMeeting(meeting.chimeMeetingId) : null;
  if (!chimeMeeting) {
    chimeMeeting = await wrapAws(createChimeMeeting(meeting._id.toString()), 'Creating the meeting');
    meeting.chimeMeetingId = chimeMeeting.MeetingId!;
    meeting.mediaRegion = chimeMeeting.MediaRegion;
  }
  const externalUserId = `guest:${g.guestId}#${crypto.randomBytes(4).toString('hex')}`;
  const attendee = await wrapAws(
    createChimeAttendee(meeting.chimeMeetingId!, externalUserId),
    'Joining the meeting'
  );

  const existing = meeting.participants.find((p: any) => p.guestId === g.guestId);
  if (existing) {
    existing.leftAt = undefined;
    existing.fullName = g.name;
    (existing as any).guestEmail = g.email || (existing as any).guestEmail;
  } else {
    meeting.participants.push({
      fullName: g.name, role: 'participant', joinedAt: new Date(),
      isGuest: true, guestId: g.guestId, guestEmail: g.email || undefined,
    } as any);
  }
  await meeting.save();

  res.json(new ApiResponse(200, {
    chime: { Meeting: chimeMeeting, Attendee: attendee },
    meeting: {
      _id: meeting._id.toString(), code: meeting.code, title: meeting.title,
      status: meeting.status, startedAt: meeting.startedAt ?? null,
      participants: pubParticipants(meeting),
      recording: { status: meeting.recording.status },
    },
    self: { crmUserId: `guest:${g.guestId}`, fullName: g.name, canControl: false, isGuest: true },
  }, 'Joined as guest'));
});

// POST /api/crm/meet/guest/:code/leave   (guest pass required)
const guestLeave = asyncHandler(async (req: Request, res: Response) => {
  const g = verifyGuest(req);
  const meeting = await findMeetingByCodePublic(String(req.params.code || ''));
  if (!meeting) throw new ApiError(404, 'No meeting found for that link.');
  const participant = meeting.participants.find((p: any) => p.guestId === g.guestId);
  if (participant && !participant.leftAt) {
    participant.leftAt = new Date();
    await meeting.save();
  }
  res.json(new ApiResponse(200, {}, 'Left meeting'));
});

// GET /api/crm/meet/guest/:code/roster   (guest pass required)
// Lets the guest UI show real names/avatars of people who join after them.
const guestRoster = asyncHandler(async (req: Request, res: Response) => {
  const g = verifyGuest(req);
  const meeting = await findMeetingByCodePublic(String(req.params.code || ''));
  if (!meeting || g.code !== meeting.code) throw new ApiError(404, 'No meeting found for that link.');
  res.json(new ApiResponse(200, { participants: pubParticipants(meeting) }, 'Roster'));
});

// ── Recording distribution (email the recording + AI summary) ───────────────
const APP_URL = (process.env.MEET_APP_URL || process.env.APP_URL || 'https://www.suprah-app.com').replace(/\/$/, '');

const whenStrMT = (d?: Date | null) =>
  d ? new Intl.DateTimeFormat('en-US', {
        timeZone: COMPANY_TZ, month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      }).format(d) + ' MT'
    : '';

/** Everyone who attended, deduped, with the best email we have for each. */
async function buildRecipients(meeting: IMeeting) {
  const internalIds = new Map<string, { name: string }>();
  const guests = new Map<string, { name: string; email: string | null }>();
  for (const p of meeting.participants as any[]) {
    if (p.crmUserId) internalIds.set(p.crmUserId.toString(), { name: p.fullName });
    else if (p.guestId) guests.set(p.guestId, { name: p.fullName, email: p.guestEmail || null });
  }
  const users = internalIds.size
    ? await CrmUser.find({ _id: { $in: [...internalIds.keys()] } }).select('fullName email').lean()
    : [];
  const byId = new Map(users.map((u: any) => [u._id.toString(), u]));
  const recipients: {
    key: string; name: string; email: string | null; kind: 'internal' | 'guest';
  }[] = [];
  for (const [id, info] of internalIds) {
    const u: any = byId.get(id);
    recipients.push({ key: id, name: u?.fullName || info.name, email: u?.email || null, kind: 'internal' });
  }
  for (const [gid, g] of guests) {
    recipients.push({ key: `guest:${gid}`, name: g.name, email: g.email, kind: 'guest' });
  }
  return recipients;
}

// GET /api/crm/meet/meetings/:code/distribution   (host / admin / manager)
const getDistribution = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can distribute the recording.');
  }
  const dist = (meeting as any).distribution;
  res.json(new ApiResponse(200, {
    recordingStatus: meeting.recording.status,
    hasVideo: Boolean(meeting.recording.videoKey),
    aiStatus: meeting.ai.status,
    hasSummary: Boolean(meeting.ai.summary?.overview),
    mailConfigured: mailConfigured(),
    alreadySent: dist?.sentAt
      ? { sentAt: dist.sentAt, count: (dist.recipients ?? []).length }
      : null,
    recipients: await buildRecipients(meeting),
  }, 'Distribution state'));
});

// POST /api/crm/meet/meetings/:code/distribute
// Body: { recipients: [{ email, name, kind }], resend?: boolean }
const distributeRecording = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can distribute the recording.');
  }
  if (!mailConfigured()) {
    throw new ApiError(503, 'Email is not configured on the server (MEET_SMTP_* env vars).');
  }
  if (meeting.recording.status !== 'ready' || !meeting.recording.videoKey) {
    throw new ApiError(409, 'The recording is not ready yet. Try again once processing finishes.');
  }
  const dist: any = (meeting as any).distribution;
  if (dist?.sentAt && !req.body?.resend) {
    throw new ApiError(409,
      `This recording was already sent on ${whenStrMT(dist.sentAt)}. Confirm resend to send it again.`);
  }
  const list: { email: string; name?: string; kind?: string }[] = Array.isArray(req.body?.recipients)
    ? req.body.recipients : [];
  const clean = list
    .map((r) => ({
      email: String(r.email || '').trim().toLowerCase(),
      name: String(r.name || '').trim().slice(0, 80),
      kind: r.kind === 'guest' ? 'guest' as const : 'internal' as const,
    }))
    .filter((r) => /^\S+@\S+\.\S+$/.test(r.email));
  if (clean.length === 0) throw new ApiError(400, 'Pick at least one recipient with a valid email.');
  if (clean.length > 100) throw new ApiError(400, 'Too many recipients (max 100).');

  const durationMin = meeting.startedAt && meeting.endedAt
    ? Math.max(1, Math.round((meeting.endedAt.getTime() - meeting.startedAt.getTime()) / 60000))
    : null;

  const results: any[] = [];
  for (const r of clean) {
    // Personal, expiring link — the email never contains a raw file URL.
    const token = jwt.sign(
      { rec: true, code: meeting.code, email: r.email },
      GUEST_SECRET, { expiresIn: '7d' }
    );
    const link = `${APP_URL}/meet/recording/${encodeURIComponent(meeting.code)}?t=${encodeURIComponent(token)}`;
    try {
      await sendRecordingEmail({
        to: r.email, recipientName: r.name || r.email,
        meetingTitle: meeting.title, code: meeting.code,
        whenStr: whenStrMT(meeting.startedAt ?? meeting.endedAt),
        durationMin, link, summary: meeting.ai.summary,
      });
      results.push({ email: r.email, name: r.name, kind: r.kind, status: 'sent' });
    } catch (err: any) {
      results.push({ email: r.email, name: r.name, kind: r.kind, status: 'failed', error: err?.message?.slice(0, 200) });
    }
  }
  (meeting as any).distribution = { sentAt: new Date(), sentBy: user._id, recipients: results };
  await meeting.save();
  res.json(new ApiResponse(200, {
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  }, 'Recording distributed'));
});

// GET /api/crm/meet/guest/recording/:code?t=...   (public — token-gated)
// The email link lands here. Validates the personal token, then returns a
// SHORT-LIVED presigned video URL + the AI summary. Expired/invalid links get
// a clear error instead of the file.
const recordingAccess = asyncHandler(async (req: Request, res: Response) => {
  const raw = String(req.query.t || '');
  if (!raw) throw new ApiError(401, 'This recording link is missing its access token.');
  let payload: any;
  try {
    payload = jwt.verify(raw, GUEST_SECRET);
  } catch (err: any) {
    throw new ApiError(401, err?.name === 'TokenExpiredError'
      ? 'This recording link has expired. Ask the meeting host to resend it.'
      : 'This recording link is invalid. Ask the meeting host to resend it.');
  }
  if (!payload?.rec || !payload?.code) throw new ApiError(401, 'This recording link is invalid.');
  const meeting = await findMeetingByCodePublic(String(req.params.code || ''));
  if (!meeting || meeting.code !== payload.code) throw new ApiError(404, 'Recording not found.');
  if (meeting.recording.status !== 'ready' || !meeting.recording.videoKey) {
    throw new ApiError(409, 'This recording is not available yet.');
  }
  const videoUrl = await presignGet(meeting.recording.videoKey);
  res.json(new ApiResponse(200, {
    title: meeting.title,
    code: meeting.code,
    whenStr: whenStrMT(meeting.startedAt ?? meeting.endedAt),
    durationMin: meeting.startedAt && meeting.endedAt
      ? Math.max(1, Math.round((meeting.endedAt.getTime() - meeting.startedAt.getTime()) / 60000))
      : null,
    videoUrl,
    summary: meeting.ai.summary ?? null,
    viewer: payload.email ?? null,
  }, 'Recording'));
});

// ── Waiting room ────────────────────────────────────────────────────────────
// Tagged attendees, the host, and admins/managers never wait; anyone joining
// purely by code asks first. The entry lives on the meeting doc, so waiting
// survives refreshes and reconnects.

// POST /api/crm/meet/meetings/:code/request-join
const requestJoin = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (meeting.status === 'ended') {
    return res.json(new ApiResponse(200, { ended: true }, 'Meeting already ended'));
  }
  if (isAllowedIn(user, meeting)) {
    return res.json(new ApiResponse(200, { admitted: true }, 'Admitted'));
  }
  const uid = user._id.toString();
  const waiting: any[] = (meeting as any).waiting ?? ((meeting as any).waiting = []);
  const entry = waiting.find((w) => w.crmUserId && w.crmUserId.toString() === uid);
  if (entry?.status === 'denied') {
    return res.json(new ApiResponse(200, { denied: true }, 'Declined by the host'));
  }
  if (!entry) {
    waiting.push({
      crmUserId: user._id,
      fullName: user.fullName,
      avatar: user.avatar || undefined,
      status: 'waiting',
      requestedAt: new Date(),
    });
    await meeting.save();
  }
  res.json(new ApiResponse(200, { waiting: true }, 'Waiting for the host'));
});

// GET /api/crm/meet/meetings/:code/waiting  (host / admin / manager)
const getWaiting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can see the waiting room.');
  }
  const waiting = (((meeting as any).waiting ?? []) as any[])
    .filter((w) => w.status === 'waiting')
    .map((w) => ({
      crmUserId: w.crmUserId ? w.crmUserId.toString() : `guest:${w.guestId}`,
      fullName: w.fullName,
      avatar: w.avatar ?? null,
      isGuest: Boolean(w.isGuest),
      requestedAt: w.requestedAt,
    }));
  res.json(new ApiResponse(200, { waiting }, 'Waiting room fetched'));
});

// POST /api/crm/meet/meetings/:code/waiting/:userId   Body: { action: 'admit' | 'deny' }
const respondWaiting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can manage the waiting room.');
  }
  const { action } = req.body ?? {};
  if (action !== 'admit' && action !== 'deny') {
    throw new ApiError(400, "action must be 'admit' or 'deny'.");
  }
  const target = String(req.params.userId || '');
  const entry = (((meeting as any).waiting ?? []) as any[]).find(
    (w) => (w.crmUserId ? w.crmUserId.toString() === target : `guest:${w.guestId}` === target)
  );
  if (!entry) throw new ApiError(404, 'That person is not in the waiting room.');
  entry.status = action === 'admit' ? 'admitted' : 'denied';
  entry.respondedAt = new Date();
  await meeting.save();
  res.json(new ApiResponse(200,
    { stillWaiting: (((meeting as any).waiting ?? []) as any[]).filter((w) => w.status === 'waiting').length },
    action === 'admit' ? 'Admitted' : 'Declined'));
});

// ── PATCH /api/crm/meet/meetings/:code ──────────────────────────────────────
// Edits an UPCOMING meeting. Body (all optional):
//   { title, scheduledAt: "YYYY-MM-DDTHH:mm" (Mountain wall time),
//     invitees[], inviteAll, inviteDepartments[] }
// ?series=1 → title + attendees also apply to every remaining scheduled
// session in the series; the time always applies to this session only.
const updateMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can edit this meeting.');
  }
  if (meeting.status !== 'scheduled') {
    throw new ApiError(400, 'Only upcoming meetings can be edited.');
  }

  const { title, scheduledAt, invitees, inviteAll, inviteDepartments, visibility } = req.body ?? {};

  // Fields that may fan out to the whole series.
  const shared: Record<string, any> = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      throw new ApiError(400, 'The title cannot be empty.');
    }
    shared.title = title.trim().slice(0, 120);
  }
  // Any audience field present → the audience was re-picked; replace it wholesale.
  if (invitees !== undefined || inviteAll !== undefined || inviteDepartments !== undefined) {
    const { inviteeList, deptKeys } = await resolveAudience(user, invitees, inviteDepartments);
    shared.invitees = inviteeList;
    shared.inviteAll = Boolean(inviteAll);
    shared.inviteDepartments = deptKeys;
  }
  if (visibility !== undefined) {
    shared.visibility = visibility === 'private' ? 'private' : 'public';
  }

  // Time applies to THIS session only — each session in a series has its own day.
  const own: Record<string, any> = {};
  if (scheduledAt !== undefined) {
    const when = mdtWallToUtc(String(scheduledAt));
    if (when.getTime() < Date.now() - 60_000) {
      throw new ApiError(400, 'That time is already in the past (MDT). Pick a future time.');
    }
    own.scheduledAt = when;
    own.reminderSentAt = null; // re-arm the 10-minute reminder for the new time
  }

  if (Object.keys(shared).length === 0 && Object.keys(own).length === 0) {
    throw new ApiError(400, 'Nothing to update.');
  }

  const wholeSeries = String(req.query.series || '') === '1' && meeting.seriesId;
  let seriesUpdated = 0;
  if (wholeSeries && Object.keys(shared).length > 0) {
    const result = await Meeting.updateMany(
      { organizationId: user.organizationId, seriesId: meeting.seriesId, status: 'scheduled' },
      { $set: shared }
    );
    seriesUpdated = result.modifiedCount ?? 0;
    if (Object.keys(own).length > 0) {
      await Meeting.updateOne({ _id: meeting._id }, { $set: own });
    }
  } else {
    await Meeting.updateOne({ _id: meeting._id }, { $set: { ...shared, ...own } });
  }

  const fresh = await Meeting.findById(meeting._id).lean();
  res.json(new ApiResponse(200, { ...serializeMeeting(fresh), seriesUpdated },
    wholeSeries ? 'Series updated' : 'Meeting updated'));
});

// ── GET /api/crm/meet/meetings ──────────────────────────────────────────────
const listMeetings = asyncHandler(async (req: Request, res: Response) => {
  const user = requireCrmUser(req);
  const meetings = await Meeting.find({
    organizationId: user.organizationId,
    $or: [
      { hostCrmUserId: user._id },
      { inviteAll: true },
      { invitees: user._id },
      { 'participants.crmUserId': user._id },
    ],
  })
    .sort({ status: 1, scheduledAt: 1, createdAt: -1 })
    .limit(200) // room for multiple 30-session series + history (frontend paginates)
    .lean();
  res.json(new ApiResponse(200, {
    meetings: meetings.map(serializeMeeting),
    selfCrmUserId: user._id.toString(),
    canManageAll: user.role === 'admin' || user.role === 'manager',
  }, 'Meetings fetched'));
});

// ── GET /api/crm/meet/alerts ────────────────────────────────────────────────
const getAlerts = asyncHandler(async (req: Request, res: Response) => {
  const user = requireCrmUser(req);
  const now = Date.now();
  const soon = new Date(now + 10 * 60_000);

  const invitedFilter = {
    organizationId: user.organizationId,
    $or: [{ inviteAll: true }, { invitees: user._id }, { hostCrmUserId: user._id }],
  };

  const [live, startingSoon] = await Promise.all([
    Meeting.find({ ...invitedFilter, status: 'live' })
      .select('code title scheduledAt startedAt hostCrmUserId').limit(10).lean(),
    Meeting.find({
      ...invitedFilter,
      status: 'scheduled',
      scheduledAt: { $gte: new Date(now - 5 * 60_000), $lte: soon },
    }).select('code title scheduledAt hostCrmUserId').limit(10).lean(),
  ]);

  res.json(new ApiResponse(200, {
    live: live.map(serializeMeeting),
    startingSoon: startingSoon.map(serializeMeeting),
  }, 'Alerts fetched'));
});

// ── POST /api/crm/meet/meetings/:code/join ──────────────────────────────────
const joinMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);

  if (meeting.status === 'ended') throw new ApiError(410, 'This meeting has already ended.');
  if (!isAllowedIn(user, meeting)) {
    throw new ApiError(403, 'The host has not admitted you to this meeting yet.');
  }

  let chimeMeeting = meeting.chimeMeetingId ? await getChimeMeeting(meeting.chimeMeetingId) : null;
  if (!chimeMeeting) {
    chimeMeeting = await wrapAws(createChimeMeeting(meeting._id.toString()), 'Creating the meeting');
    meeting.chimeMeetingId = chimeMeeting.MeetingId!;
    meeting.mediaRegion = chimeMeeting.MediaRegion;
  }

  // Session-unique ExternalUserId (crmUserId#session) so the same CRM user
  // can join from two devices without Chime kicking the first session.
  const externalUserId = `${user._id.toString()}#${crypto.randomBytes(4).toString('hex')}`;
  const attendee = await wrapAws(
    createChimeAttendee(meeting.chimeMeetingId!, externalUserId),
    'Joining the meeting'
  );

  if (meeting.status === 'scheduled') {
    meeting.status = 'live';
    meeting.startedAt = new Date();
  }

  const isHost = meeting.hostCrmUserId.toString() === user._id.toString();
  const existing = meeting.participants.find((p) => p.crmUserId && p.crmUserId.toString() === user._id.toString());
  if (existing) {
    existing.leftAt = undefined;
    existing.fullName = user.fullName;
    existing.avatar = user.avatar || undefined;
  } else {
    meeting.participants.push({
      crmUserId: user._id,
      fullName: user.fullName,
      avatar: user.avatar || undefined,
      role: isHost ? 'host' : 'participant',
      joinedAt: new Date(),
    } as any);
  }
  await meeting.save();

  res.json(new ApiResponse(200, {
    chime: { Meeting: chimeMeeting, Attendee: attendee },
    meeting: serializeMeeting(meeting),
    self: {
      crmUserId: user._id.toString(),
      fullName: user.fullName,
      canControl: canControl(user, meeting),
    },
  }, 'Joined meeting'));
});

// ── GET /api/crm/meet/meetings/:code ────────────────────────────────────────
const getMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { meeting } = await findOrgMeeting(req);
  res.json(new ApiResponse(200, serializeMeeting(meeting), 'Meeting fetched'));
});

// ── POST /api/crm/meet/meetings/:code/leave ─────────────────────────────────
const leaveMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  const participant = meeting.participants.find((p) => p.crmUserId && p.crmUserId.toString() === user._id.toString());
  if (participant) {
    participant.leftAt = new Date();
    await meeting.save();
  }
  res.json(new ApiResponse(200, null, 'Left meeting'));
});

// ── POST /api/crm/meet/meetings/:code/end ───────────────────────────────────
const endMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  // Host-only end: the host can always end for everyone. An admin/manager may
  // end ONLY when the host is not currently in the room (host-absent fallback).
  const isHost = meeting.hostCrmUserId.toString() === user._id.toString();
  const hostPresent = meeting.participants.some(
    (p) => p.crmUserId && p.crmUserId.toString() === meeting.hostCrmUserId.toString() && !p.leftAt
  );
  const isElevated = user.role === 'admin' || user.role === 'manager';
  if (!isHost && !(isElevated && !hostPresent)) {
    throw new ApiError(403, hostPresent
      ? 'Only the host can end this meeting while they are in the room.'
      : 'Only the host or an admin/manager can end the meeting.');
  }
  if (meeting.status === 'ended') {
    return res.json(new ApiResponse(200, serializeMeeting(meeting), 'Meeting already ended'));
  }

  if (meeting.recording.status === 'recording' && meeting.recording.capturePipelineId) {
    try {
      await stopRecordingPipelines(meeting.recording.capturePipelineId);
      meeting.recording.status = 'processing';
      meeting.recording.stoppedAt = new Date();
    } catch (err: any) {
      meeting.recording.status = 'failed';
      meeting.recording.error = err?.message || 'Failed to stop recording';
    }
  }

  if (meeting.chimeMeetingId) await deleteChimeMeeting(meeting.chimeMeetingId).catch(() => {});

  meeting.status = 'ended';
  meeting.endedAt = new Date();
  meeting.participants.forEach((p) => { if (!p.leftAt) p.leftAt = new Date(); });
  await meeting.save();

  res.json(new ApiResponse(200, serializeMeeting(meeting), 'Meeting ended'));
});

// ── Recording ───────────────────────────────────────────────────────────────
// These two respond DIRECTLY on AWS failure (no throw) so the exact AWS
// reason always reaches the browser instead of the middleware's "{}".
const startRecording = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) throw new ApiError(403, 'Only the host or an admin/manager can record this meeting.');
  if (meeting.status !== 'live' || !meeting.chimeMeetingId) throw new ApiError(400, 'The meeting must be live before recording can start.');
  if (meeting.recording.status === 'recording') throw new ApiError(409, 'This meeting is already being recorded.');

  const s3Prefix = `meetings/${meeting._id}/${Date.now()}`;
  let pipelines;
  try {
    pipelines = await startRecordingPipelines(meeting.chimeMeetingId, s3Prefix);
  } catch (err: any) {
    return res.status(502).json(awsFailurePayload(err, 'Starting the recording'));
  }

  meeting.recording.status = 'recording';
  meeting.recording.capturePipelineId = pipelines.capturePipelineId;
  meeting.recording.capturePipelineArn = pipelines.capturePipelineArn;
  meeting.recording.concatPipelineId = pipelines.concatPipelineId;
  meeting.recording.s3Prefix = s3Prefix;
  meeting.recording.startedAt = new Date();
  meeting.recording.stoppedAt = undefined;
  meeting.recording.videoKey = undefined;
  meeting.recording.error = undefined;
  await meeting.save();

  res.json(new ApiResponse(200, { recording: meeting.recording }, 'Recording started'));
});

const stopRecording = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) throw new ApiError(403, 'Only the host or an admin/manager can stop the recording.');
  if (meeting.recording.status !== 'recording' || !meeting.recording.capturePipelineId) {
    throw new ApiError(400, 'No active recording to stop.');
  }
  try {
    await stopRecordingPipelines(meeting.recording.capturePipelineId);
  } catch (err: any) {
    return res.status(502).json(awsFailurePayload(err, 'Stopping the recording'));
  }
  meeting.recording.status = 'processing';
  meeting.recording.stoppedAt = new Date();
  await meeting.save();
  res.json(new ApiResponse(200, { recording: meeting.recording }, 'Recording stopped — processing'));
});

const getRecordings = asyncHandler(async (req: Request, res: Response) => {
  const { meeting } = await findOrgMeeting(req);
  if (meeting.recording.status === 'processing' && meeting.recording.s3Prefix) {
    const key = await findConcatenatedVideoKey(meeting.recording.s3Prefix);
    if (key) {
      meeting.recording.status = 'ready';
      meeting.recording.videoKey = key;
      await meeting.save();
    }
  }
  const downloadUrl = meeting.recording.videoKey ? await presignGet(meeting.recording.videoKey) : null;
  res.json(new ApiResponse(200, { recording: meeting.recording, downloadUrl }, 'Recording status fetched'));
});

// ── AI ──────────────────────────────────────────────────────────────────────
const processAi = asyncHandler(async (req: Request, res: Response) => {
  const { meeting } = await findOrgMeeting(req);
  if (meeting.ai.status === 'ready') return res.json(new ApiResponse(200, { ai: meeting.ai }, 'Summary already generated'));
  if (meeting.ai.status === 'transcribing' || meeting.ai.status === 'summarizing') {
    return res.json(new ApiResponse(200, { ai: meeting.ai }, 'Processing already in progress'));
  }
  if (meeting.recording.status === 'processing' && meeting.recording.s3Prefix) {
    const key = await findConcatenatedVideoKey(meeting.recording.s3Prefix);
    if (key) { meeting.recording.status = 'ready'; meeting.recording.videoKey = key; }
  }
  if (meeting.recording.status !== 'ready' || !meeting.recording.videoKey) {
    throw new ApiError(409, 'The recording is still processing. Try again in a minute — the AI summary needs the finished recording.');
  }
  const { jobName, transcriptKey } = await wrapAws(
    startTranscription(meeting, meeting.recording.videoKey),
    'Starting transcription'
  );
  meeting.ai.status = 'transcribing';
  meeting.ai.transcriptionJobName = jobName;
  meeting.ai.transcriptKey = transcriptKey;
  meeting.ai.error = undefined;
  await meeting.save();
  res.json(new ApiResponse(200, { ai: meeting.ai }, 'AI processing started'));
});

const getAi = asyncHandler(async (req: Request, res: Response) => {
  const { meeting } = await findOrgMeeting(req);
  if (meeting.ai.status === 'transcribing' && meeting.ai.transcriptionJobName) {
    const status = await getTranscriptionStatus(meeting.ai.transcriptionJobName);
    if (status === 'FAILED') {
      meeting.ai.status = 'failed';
      meeting.ai.error = 'Transcription failed';
      await meeting.save();
    } else if (status === 'COMPLETED' && meeting.ai.transcriptKey) {
      meeting.ai.status = 'summarizing';
      await meeting.save();
      try {
        const transcript = await readTranscriptText(meeting.ai.transcriptKey);
        if (!transcript) throw new Error('Transcript was empty');
        meeting.ai.summary = await generateSummary(meeting, transcript);
        meeting.ai.status = 'ready';
        meeting.ai.generatedAt = new Date();
      } catch (err: any) {
        meeting.ai.status = 'failed';
        meeting.ai.error = err?.message || 'Summarization failed';
      }
      await meeting.save();
    }
  }
  res.json(new ApiResponse(200, { ai: meeting.ai }, 'AI status fetched'));
});

// ── Serialization ───────────────────────────────────────────────────────────
function serializeMeeting(m: any) {
  return {
    _id: m._id,
    code: m.code,
    title: m.title,
    status: m.status,
    visibility: m.visibility === 'private' ? 'private' : 'public',
    scheduledAt: m.scheduledAt ?? null,
    seriesId: m.seriesId ?? null,
    inviteAll: Boolean(m.inviteAll),
    invitees: (m.invitees ?? []).map((id: any) => id.toString()),
    inviteDepartments: m.inviteDepartments ?? [],
    hostCrmUserId: m.hostCrmUserId?.toString?.() ?? m.hostCrmUserId,
    participants: (m.participants ?? []).map((p: any) => ({
      crmUserId: p.crmUserId ? p.crmUserId.toString() : (p.guestId ? `guest:${p.guestId}` : null),
      fullName: p.fullName,
      isGuest: Boolean((p as any).isGuest),
      avatar: p.avatar ?? null,
      role: p.role,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
    })),
    recording: {
      status: m.recording?.status ?? 'idle',
      startedAt: m.recording?.startedAt,
      stoppedAt: m.recording?.stoppedAt,
    },
    ai: { status: m.ai?.status ?? 'idle', summary: m.ai?.summary, generatedAt: m.ai?.generatedAt },
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    createdAt: m.createdAt,
  };
}

export default {
  createMeeting, listMeetings, getMeeting, joinMeeting, leaveMeeting, endMeeting,
  deleteMeeting, updateMeeting, requestJoin, getWaiting, respondWaiting,
  guestRequest, guestJoin, guestLeave, guestRoster,
  getDistribution, distributeRecording, recordingAccess, startRecording, stopRecording, getRecordings, processAi, getAi, getAlerts,
};
