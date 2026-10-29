import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import Lead from '../models/lead.model';
import { CallLog } from '../models/communication.model';
import { CallRecording, CallRecordingSettings, CallRecordingGrant, CallRecordingAudit, CallRecordingShare, CallRecordingMediaSession, CallRecordingEvent, RECORDING_PERMISSIONS, GRANTABLE_RECORDING_PERMISSIONS } from '../models/CallRecording.model';
import { recordingPrincipal, recordingPermissions, requireRecordingPermission, recordingAudit, RecordingPrincipal } from '../services/callRecordingAccess.service';
import { recordingSettingsInput, getRecordingSettings, controlRecording, startManualRecording, recordingReady, callRepId, deleteRecording, hashToken } from '../services/callRecording.service';
import { streamRecordingFile } from '../services/callRecordingStorage.service';
import { recordingMediaAuth } from '../services/recordingMediaAuth.service';

async function principal(req: Request) {
  return recordingPrincipal(String(req.crmUser?._id || req.user?._id), String(req.orgId));
}
function validId(id: string) { if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid ID'); return id; }
async function admin(req: Request) {
  const p = await principal(req);
  if (!p.admin) throw new ApiError(403, 'Verified administrator required');
  return p;
}
const grantable = (permissions: unknown) => (Array.isArray(permissions) ? permissions : []).filter((p: any) => (GRANTABLE_RECORDING_PERMISSIONS as readonly string[]).includes(p));
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function principalName(p: RecordingPrincipal) {
  if (p.kind === 'crm') return String((await CrmUser.findById(p.id).select('fullName').lean() as any)?.fullName || '');
  return String((await User.findById(p.id).select('name').lean() as any)?.name || '');
}
function summary(record: any) {
  return { _id: record._id, callLogId: record.callLogId, direction: record.direction, state: record.state, manualPaused: record.manualPaused, incomplete: record.incomplete, error: record.error, startedAt: record.startedAt, endedAt: record.endedAt, expiresAt: record.expiresAt, reviewedAt: record.reviewedAt, reviewedByName: record.reviewedByName, files: record.files.map((f: any) => ({ _id: f._id, bytes: f.bytes, startedAt: f.startedAt, endedAt: f.endedAt })) };
}
async function accessible(p: RecordingPrincipal, id: string, permission: typeof RECORDING_PERMISSIONS[number] = 'view') {
  await requireRecordingPermission(p, permission);
  const record: any = await CallRecording.findOne({ _id: validId(id), organizationId: p.orgId });
  if (!record || ['deleted', 'deleting'].includes(record.state) || (record.expiresAt && record.expiresAt <= new Date())) throw new ApiError(404, 'Recording unavailable');
  return record;
}
export const getAccess = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { permissions: await recordingPermissions(p), admin: p.admin } });
});
export const getSettings = asyncHandler(async (req: Request, res: Response) => {
  const p = await admin(req);
  const settings = await getRecordingSettings(p.orgId);
  const grants: any[] = (await CallRecordingGrant.find({ organizationId: p.orgId }).lean()).map((g: any) => ({ ...g, permissions: grantable(g.permissions) }));
  const crm: any[] = await CrmUser.find({ organizationId: p.orgId, isActive: true, isSystem: { $ne: true }, isOffboarded: { $ne: true } }).select('fullName email role department avatar').lean();
  const main: any[] = await User.find({ organizationId: p.orgId, isActive: true, role: { $in: ['employee', 'admin', 'super_admin'] }, $or: [{ email: { $nin: crm.map(u => u.email) } }, { _id: { $in: grants.filter(g => g.principalKind === 'main' && g.permissions.length).map(g => g.principalId) } }] }).select('name email role personalInfo.department avatar').lean();
  res.json({ data: { settings: { announcementText: settings.announcementText, retentionMonths: settings.retentionMonths }, grants, staff: [...crm.map(u => ({ id: String(u._id), kind: 'crm', name: u.fullName, email: u.email, role: u.role, department: u.department, avatar: u.avatar })), ...main.map(u => ({ id: String(u._id), kind: 'main', name: u.name, email: u.email, role: u.role, department: u.personalInfo?.department, avatar: u.avatar }))], permissions: GRANTABLE_RECORDING_PERMISSIONS } });
});
export const saveSettings = asyncHandler(async (req: Request, res: Response) => {
  const p = await admin(req);
  const parsed = recordingSettingsInput.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map(i => i.message).join('; '));
  await CallRecordingSettings.updateOne({ organizationId: p.orgId }, { $set: { ...parsed.data, updatedBy: p.id } }, { upsert: true });
  await recordingAudit(p, 'settings.saved', undefined, parsed.data);
  res.json({ data: { settings: parsed.data } });
});
export const saveGrant = asyncHandler(async (req: Request, res: Response) => {
  const p = await admin(req);
  const input = z.object({ principalId: z.string(), principalKind: z.enum(['crm', 'main']), permissions: z.array(z.enum(RECORDING_PERMISSIONS)).max(RECORDING_PERMISSIONS.length) }).safeParse(req.body);
  if (!input.success) throw new ApiError(400, 'Invalid recording grant');
  await recordingPrincipal(validId(input.data.principalId), p.orgId, input.data.principalKind);
  await CallRecordingGrant.updateOne({ organizationId: p.orgId, principalId: input.data.principalId, principalKind: input.data.principalKind }, { $set: { permissions: [...new Set(grantable(input.data.permissions))], updatedBy: p.id } }, { upsert: true });
  await recordingAudit(p, 'permission.changed', undefined, input.data);
  res.json({ data: { saved: true } });
});
export const getCallRecording = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const permissions = await recordingPermissions(p);
  const call: any = await CallLog.findOne({ _id: validId(req.params.id), orgId: p.orgId }).select('+recordingCorrelation');
  const own = Boolean(call && callRepId(call) === p.id);
  if (!own && !permissions.includes('view')) throw new ApiError(403, 'Recording permission required');
  const record: any = await CallRecording.findOne({ callLogId: validId(req.params.id), organizationId: p.orgId });
  const restartable = !record || (record.state === 'failed' && !record.startedAt && !record.files.length);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { recording: record ? summary(record) : null, permissions, canStart: Boolean(own && restartable && recordingReady(call)), canControl: Boolean(own && call?.status === 'in-progress') } });
});
export const control = asyncHandler(async (req: Request, res: Response) => {
  const action = z.enum(['start', 'pause', 'resume']).safeParse(req.body?.action);
  if (!action.success) throw new ApiError(400, 'Invalid control');
  const p = await principal(req);
  if (action.data === 'start') await startManualRecording(p, validId(req.params.id));
  else await controlRecording(p, validId(req.params.id), action.data);
  res.json({ data: { accepted: true } });
});
const listInput = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  reviewed: z.enum(['all', 'reviewed', 'unreviewed']).default('all'),
  repId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  search: z.string().trim().max(80).optional(),
});
const PAGE_SIZE = 25;
async function staffNames(ids: string[]) {
  const valid = [...new Set(ids.filter(id => mongoose.isValidObjectId(id)))];
  if (!valid.length) return new Map<string, string>();
  const [crm, main]: any[] = await Promise.all([CrmUser.find({ _id: { $in: valid } }).select('fullName').lean(), User.find({ _id: { $in: valid } }).select('name').lean()]);
  return new Map<string, string>([...main.map((u: any) => [String(u._id), u.name]), ...crm.map((u: any) => [String(u._id), u.fullName])] as [string, string][]);
}
export const listRecordings = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  await requireRecordingPermission(p, 'view');
  const input = listInput.safeParse(req.query);
  if (!input.success) throw new ApiError(400, 'Invalid recording filters');
  const { page, from, to, reviewed, repId, search } = input.data;
  const filter: any = { organizationId: p.orgId, state: { $nin: ['deleted', 'deleting'] }, startedAt: { $ne: null, ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
  if (reviewed === 'reviewed') filter.reviewedAt = { $ne: null };
  if (reviewed === 'unreviewed') filter.reviewedAt = null;
  if (repId) filter.employeeId = repId;
  if (search) {
    const digits = search.replace(/\D/g, '');
    const words = new RegExp(escapeRegex(search), 'i');
    const parts = search.split(/\s+/).filter(Boolean);
    const leadClauses: any[] = [{ firstName: words }, { lastName: words }];
    if (parts.length > 1) leadClauses.push({ firstName: new RegExp(escapeRegex(parts[0]), 'i'), lastName: new RegExp(escapeRegex(parts[1]), 'i') });
    if (digits.length >= 3) leadClauses.push({ phone: new RegExp(digits.split('').join('\\D*')) });
    const [leads, calls]: any[] = await Promise.all([
      Lead.find({ organizationId: p.orgId, $or: leadClauses }).select('_id').limit(500).lean(),
      digits.length >= 3 ? CallLog.find({ orgId: p.orgId, $or: [{ from: new RegExp(digits) }, { to: new RegExp(digits) }] }).select('_id').limit(500).lean() : [],
    ]);
    filter.$and = [{ $or: [{ leadId: { $in: leads.map((l: any) => l._id) } }, { callLogId: { $in: calls.map((c: any) => c._id) } }] }];
  }
  const [total, rows, repIds]: any[] = await Promise.all([
    CallRecording.countDocuments(filter),
    CallRecording.find(filter).sort({ startedAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    CallRecording.distinct('employeeId', { organizationId: p.orgId, state: { $nin: ['deleted', 'deleting'] }, startedAt: { $ne: null } }),
  ]);
  const calls: any[] = await CallLog.find({ _id: { $in: rows.map((r: any) => r.callLogId) } }).select('from to direction durationSec answeredAt endedAt lineLabel answeredBy placedBy leadId').lean();
  const callById = new Map(calls.map(c => [String(c._id), c]));
  const leadIds = rows.map((r: any) => r.leadId || callById.get(String(r.callLogId))?.leadId).filter(Boolean);
  const leads: any[] = leadIds.length ? await Lead.find({ _id: { $in: leadIds }, organizationId: p.orgId }).select('firstName lastName phone').lean() : [];
  const leadById = new Map(leads.map(l => [String(l._id), l]));
  const names = await staffNames([...rows.map((r: any) => String(r.employeeId || '')), ...repIds.map(String)]);
  const items = rows.map((r: any) => {
    const call = callById.get(String(r.callLogId)) || {};
    const leadId = String(r.leadId || call.leadId || '');
    const lead = leadById.get(leadId);
    const customerPhone = call.direction === 'outbound' ? call.to : call.from;
    const customerName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() : '';
    const answered = call.answeredAt && call.endedAt ? Math.max(0, Math.round((new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000)) : null;
    return {
      _id: r._id, callLogId: r.callLogId, leadId: lead ? leadId : null, customerName: customerName || '', customerPhone: customerPhone || lead?.phone || '',
      repId: r.employeeId || '', repName: names.get(String(r.employeeId)) || (call.answeredBy || call.placedBy)?.name || '',
      direction: r.direction || call.direction, line: call.lineLabel || (call.direction === 'outbound' ? call.from : call.to) || '',
      durationSec: typeof call.durationSec === 'number' ? call.durationSec : answered,
      startedAt: r.startedAt, endedAt: r.endedAt, state: r.state, incomplete: Boolean(r.incomplete), reviewedAt: r.reviewedAt || null, reviewedByName: r.reviewedByName || '',
    };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { items, total, page, pageSize: PAGE_SIZE, reps: repIds.map((id: string) => ({ id: String(id), name: names.get(String(id)) || 'Former employee' })).sort((a: any, b: any) => a.name.localeCompare(b.name)) } });
});
export const getRecording = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const record = await accessible(p, req.params.id);
  await recordingAudit(p, 'recording.viewed', record._id);
  const audits = await CallRecordingAudit.find({ organizationId: p.orgId, recordingId: record._id }).sort({ createdAt: -1 }).limit(100).lean();
  const shares = await CallRecordingShare.find({ organizationId: p.orgId, recordingId: record._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { recording: summary(record), permissions: await recordingPermissions(p), audits, shares } });
});
export const reviewRecording = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const record = await accessible(p, req.params.id, 'review');
  const reviewedAt = new Date();
  const reviewedByName = await principalName(p);
  await CallRecording.updateOne({ _id: record._id }, { $set: { reviewedAt, reviewedBy: p.id, reviewedByName } });
  await recordingAudit(p, 'recording.reviewed', record._id);
  res.json({ data: { reviewed: true, reviewedAt, reviewedByName } });
});
export const removeRecording = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const record = await accessible(p, req.params.id, 'delete');
  if (!record.endedAt) throw new ApiError(409, 'Cannot delete an active recording');
  await deleteRecording(record, p);
  res.json({ data: { deleted: true } });
});
export const retryImport = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const record = await accessible(p, req.params.id, 'review');
  if (!record.endedAt || !record.startedAt || !['failed', 'processing'].includes(record.state)) throw new ApiError(409, 'No failed import to retry');
  await recordingAudit(p, 'import.retry-requested', record._id);
  await CallRecordingEvent.updateMany({ 'payload.call_session_id': record.sessionId, 'payload.call_leg_id': record.legId, type: { $in: ['call.recording.saved'] }, state: { $in: ['failed', 'pending'] } }, { $set: { state: 'pending', attempts: 0, nextAttemptAt: new Date() }, $unset: { leaseUntil: '', error: '' } });
  await CallRecording.updateOne({ _id: record._id, state: { $in: ['failed', 'processing'] } }, { $set: { state: 'processing', nextReconcileAt: new Date(), reconcileAttempts: 0, error: 'Import retry pending', incomplete: true } });
  res.json({ data: { accepted: true } });
});
async function getShare(p: RecordingPrincipal, id: string) {
  const share: any = await CallRecordingShare.findOne({ _id: validId(id), organizationId: p.orgId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
  if (!share) throw new ApiError(404, 'Share expired or revoked');
  return share;
}
export const createShare = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const record = await accessible(p, req.params.id, 'share');
  await requireRecordingPermission(p, 'view');
  const expiresAt = new Date(Math.min(Date.now() + 7 * 86400000, record.expiresAt?.getTime() || Infinity));
  const share = await CallRecordingShare.create({ organizationId: p.orgId, recordingId: record._id, createdBy: p.id, expiresAt });
  await recordingAudit(p, 'share.created', record._id, { shareId: share._id, expiresAt });
  res.json({ data: { shareId: share._id, expiresAt } });
});
export const revokeShare = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  await requireRecordingPermission(p, 'share');
  const share = await getShare(p, req.params.id);
  await accessible(p, String(share.recordingId));
  await CallRecordingShare.updateOne({ _id: share._id }, { $set: { revokedAt: new Date() } });
  await recordingAudit(p, 'share.revoked', share.recordingId, { shareId: share._id });
  res.json({ data: { revoked: true } });
});
export const resolveShare = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const share = await getShare(p, req.params.id);
  const record = await accessible(p, String(share.recordingId));
  await recordingAudit(p, 'share.accessed', record._id, { shareId: share._id });
  res.json({ data: { recording: summary(record) } });
});
export const createMediaSession = asyncHandler(async (req: Request, res: Response) => {
  const p = await principal(req);
  const input = z.object({ mode: z.enum(['play', 'download']), fileId: z.string(), shareId: z.string().optional() }).safeParse(req.body);
  if (!input.success) throw new ApiError(400, 'Invalid media session');
  const record = await accessible(p, req.params.id, input.data.mode === 'play' ? 'view' : 'download');
  if (!record.files.some((f: any) => String(f._id) === input.data.fileId)) throw new ApiError(404, 'File not found');
  if (input.data.shareId && String((await getShare(p, input.data.shareId)).recordingId) !== String(record._id)) throw new ApiError(403, 'Share mismatch');
  const auth = await recordingMediaAuth(req, p);
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60000);
  const session = await CallRecordingMediaSession.create({ organizationId: p.orgId, recordingId: record._id, fileId: input.data.fileId, principalId: p.id, principalKind: p.kind, authKind: auth.authKind, authSessionId: auth.authSessionId, authUserId: auth.authUserId, mode: input.data.mode, tokenHash: hashToken(token), expiresAt, shareId: input.data.shareId });
  const path = `/api/crm/communications/recordings/media/${session._id}`;
  res.cookie('recording_media', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path, maxAge: 15 * 60000 });
  if (auth.crmToken && !req.cookies?.crm_token) res.cookie('crm_token', auth.crmToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  await recordingAudit(p, input.data.mode === 'play' ? 'playback.requested' : 'download.requested', record._id, { fileId: input.data.fileId, shareId: input.data.shareId });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { path, expiresAt } });
});
export const mediaSession = asyncHandler(async (req: Request, res: Response) => {
  const session: any = await CallRecordingMediaSession.findOne({ _id: validId(req.params.id), tokenHash: hashToken(req.cookies?.recording_media || ''), expiresAt: { $gt: new Date() } });
  if (!session) throw new ApiError(401, 'Media session expired');
  const auth = await recordingMediaAuth(req);
  const p = auth.p;
  if (session.authKind !== auth.authKind || session.authSessionId !== auth.authSessionId || session.authUserId !== auth.authUserId || session.principalId !== p.id || session.principalKind !== p.kind || session.organizationId !== p.orgId) throw new ApiError(401, 'Media belongs to a different login session');
  const record = await accessible(p, String(session.recordingId), session.mode === 'play' ? 'view' : 'download');
  if (session.shareId) await getShare(p, String(session.shareId));
  const file = record.files.find((f: any) => String(f._id) === session.fileId);
  if (!file) throw new ApiError(404, 'File unavailable');
  const range = req.header('range');
  if (range && !/^bytes=\d+-\d*$/.test(range)) throw new ApiError(416, 'Unsupported range');
  const content = await streamRecordingFile(file.key, range);
  await recordingAudit(p, session.mode === 'play' ? 'playback.accessed' : 'download.accessed', record._id, { fileId: session.fileId, range });
  res.status(range ? 206 : 200);
  res.set({ 'Content-Type': content.type, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${session.mode === 'download' ? 'attachment' : 'inline'}; filename="call-${record._id}.mp3"` });
  if (content.length !== undefined) res.setHeader('Content-Length', content.length);
  if (content.range) res.setHeader('Content-Range', content.range);
  content.stream.on('error', () => res.destroy());
  res.on('close', () => content.stream.destroy());
  content.stream.pipe(res);
});
