import { Request, Response } from 'express';
import crypto from 'crypto';
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

const MDT_OFFSET_MINUTES = -360; // matches COMPANY_TZ_OFFSET_MINUTES elsewhere
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

/** "YYYY-MM-DDTHH:mm" interpreted as MDT wall time → UTC Date. */
function mdtWallToUtc(wall: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) {
    throw new ApiError(400, 'Scheduled times must be "YYYY-MM-DDTHH:mm" (MDT).');
  }
  return new Date(Date.parse(`${wall}:00.000Z`) - MDT_OFFSET_MINUTES * 60_000);
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

// ── POST /api/crm/meet/meetings ─────────────────────────────────────────────
// Body: { title, invitees[], inviteAll, inviteDepartments[],
//         scheduledAt?: "YYYY-MM-DDTHH:mm",           ← single session
//         occurrences?: ["YYYY-MM-DDTHH:mm", ...] }   ← recurring series
const createMeeting = asyncHandler(async (req: Request, res: Response) => {
  const user = requireCrmUser(req);
  const { title, scheduledAt, occurrences, invitees, inviteAll, inviteDepartments } = req.body ?? {};

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

  // Directly tagged people
  const inviteeIds = Array.isArray(invitees)
    ? invitees.filter((id: any) => mongoose.isValidObjectId(id)).slice(0, 200)
    : [];
  const directInvitees = inviteeIds.length
    ? (await CrmUser.find({ _id: { $in: inviteeIds }, organizationId: user.organizationId })
        .select('_id').lean()).map((u) => u._id)
    : [];

  // Tagged departments — resolved to their members at creation time so
  // visibility, alerts, and reminders all work off `invitees` unchanged.
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

  const base = {
    organizationId: user.organizationId,
    title: cleanTitle,
    hostCrmUserId: user._id,
    invitees: [...merged.values()],
    inviteAll: Boolean(inviteAll),
    inviteDepartments: deptKeys,
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
    .limit(80)
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
  const existing = meeting.participants.find((p) => p.crmUserId.toString() === user._id.toString());
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
  const participant = meeting.participants.find((p) => p.crmUserId.toString() === user._id.toString());
  if (participant) {
    participant.leftAt = new Date();
    await meeting.save();
  }
  res.json(new ApiResponse(200, null, 'Left meeting'));
});

// ── POST /api/crm/meet/meetings/:code/end ───────────────────────────────────
const endMeeting = asyncHandler(async (req: Request, res: Response) => {
  const { user, meeting } = await findOrgMeeting(req);
  if (!canControl(user, meeting)) {
    throw new ApiError(403, 'Only the host or an admin/manager can end the meeting.');
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
    scheduledAt: m.scheduledAt ?? null,
    seriesId: m.seriesId ?? null,
    inviteAll: Boolean(m.inviteAll),
    invitees: (m.invitees ?? []).map((id: any) => id.toString()),
    inviteDepartments: m.inviteDepartments ?? [],
    hostCrmUserId: m.hostCrmUserId?.toString?.() ?? m.hostCrmUserId,
    participants: (m.participants ?? []).map((p: any) => ({
      crmUserId: p.crmUserId?.toString?.() ?? p.crmUserId,
      fullName: p.fullName,
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
  deleteMeeting, startRecording, stopRecording, getRecordings, processAi, getAi, getAlerts,
};