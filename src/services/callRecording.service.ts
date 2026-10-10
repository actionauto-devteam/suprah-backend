import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { CallLog } from '../models/communication.model';
import { CallRecording, CallRecordingPolicy, CallRecordingEvent, CallRecordingShare } from '../models/CallRecording.model';
import { ApiError } from '../utils/ApiError';
import * as telnyx from './telnyx.service';
import * as media from './callRecordingStorage.service';
import { RecordingPrincipal, requireRecordingPermission, recordingAudit } from './callRecordingAccess.service';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const recordingPolicyInput = z.object({
  name: z.string().trim().min(1).max(120), number: z.string().regex(/^\+[1-9]\d{7,14}$/), direction: z.enum(['inbound', 'outbound']),
  enabled: z.boolean().default(false), retentionMonths: z.number().int().min(1).max(120).default(6),
  connectionId: z.string().max(120).default(''), legalApproved: z.boolean().default(false), providerVerified: z.boolean().default(false),
  disclosureOwner: z.enum(['pending', 'suprah', 'provider']).default('pending'), disclosureText: z.string().trim().max(3000).default(''),
  disclosureLanguage: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).default('en-US'), providerDisclosureVerified: z.boolean().default(false),
  consentMode: z.enum(['pending', 'notice', 'staff-confirmed']).default('pending'),
}).strict().superRefine((input, ctx) => {
  if (input.enabled && (!input.legalApproved || !input.providerVerified || !input.connectionId || input.consentMode === 'pending' || input.disclosureOwner === 'pending' || (input.disclosureOwner === 'suprah' && !input.disclosureText) || (input.disclosureOwner === 'provider' && !input.providerDisclosureVerified))) {
    ctx.addIssue({ code: 'custom', message: 'Legal, provider, connection, disclosure and consent configuration must be verified before enabling recording' });
  }
});

export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const end = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, end));
  return result;
}

export function decodeRecordingState(value: string | undefined): any {
  try { return value ? JSON.parse(Buffer.from(value, 'base64').toString('utf8')) : null; } catch { return null; }
}

async function policyFor(call: any, enabled = true): Promise<any> {
  const policy: any = await CallRecordingPolicy.findOne({ organizationId: String(call.orgId), number: call.direction === 'inbound' ? call.to : call.from, direction: call.direction, ...(enabled ? { enabled: true } : {}) }).lean();
  if (!policy) return null;
  const { _id, __v, createdAt, updatedAt, organizationId, version, updatedBy, ...input } = policy;
  const parsed = recordingPolicyInput.safeParse(input);
  return parsed.success ? policy : null;
}

export async function createOutboundCorrelation(call: any, principal: RecordingPrincipal) {
  if (call.direction !== 'outbound' || String(call.placedBy?.userId) !== principal.id) throw new ApiError(403, 'Call ownership required');
  const token = randomBytes(32).toString('hex');
  await CallLog.updateOne({ _id: call._id, orgId: principal.orgId }, { $set: { 'recordingCorrelation.tokenHash': hashToken(token) } });
  return { callLogId: String(call._id), token };
}

async function locate(payload: any): Promise<any> {
  const tag = decodeRecordingState(payload.client_state);
  if (tag?.kind === 'recording-outbound') {
    if (!/^[a-f0-9]{24}$/i.test(tag.callLogId || '') || typeof tag.token !== 'string') return null;
    const call: any = await CallLog.findById(tag.callLogId).select('+recordingCorrelation');
    if (!call || call.direction !== 'outbound' || hashToken(tag.token) !== call.recordingCorrelation?.tokenHash) return null;
    const policy = await policyFor(call, false);
    if (!policy?.connectionId || policy.connectionId !== payload.connection_id || payload.to !== call.to || payload.from !== call.from) return null;
    return call;
  }
  if (!payload.call_session_id) return null;
  if (tag?.kind === 'agent-leg' && /^[a-f0-9]{24}$/i.test(tag.callLogId || '')) return CallLog.findById(tag.callLogId).select('+recordingCorrelation');
  return CallLog.findOne({ providerCallSessionId: payload.call_session_id }).select('+recordingCorrelation');
}

export async function enqueueRecordingEvent(eventId: string, type: string, payload: any): Promise<boolean> {
  if (!eventId || eventId.length > 160) throw new Error('Recording webhook event ID required');
  await CallRecordingEvent.updateOne({ eventId }, { $setOnInsert: { eventId, type, payload, nextAttemptAt: new Date(Date.now() + (type.startsWith('call.recording.') ? 0 : 2000)) } }, { upsert: true });
  return true;
}

async function change(record: any, state: string, extra: Record<string, unknown> = {}) {
  return CallRecording.findOneAndUpdate({ _id: record._id, revision: record.revision, state: record.state }, { $set: { state, ...extra }, $inc: { revision: 1 } }, { new: true });
}

async function markFailure(record: any, error: unknown) {
  await CallRecording.updateOne({ _id: record._id }, { $set: { state: 'failed', incomplete: true, error: error instanceof Error ? error.message.slice(0, 300) : 'Recording failed' } });
}

export async function maybeStartRecording(callId: string): Promise<void> {
  const call: any = await CallLog.findById(callId).select('+recordingCorrelation');
  if (!call || !call.recordingCorrelation?.verified || !call.recordingCorrelation?.answerControlId || (call.direction === 'inbound' && !call.recordingCorrelation.bridged) || !['in-progress', 'answering', 'ringing'].includes(call.status)) return;
  const policy = await policyFor(call);
  if (!policy || policy.connectionId !== call.recordingCorrelation.connectionId) return;
  const record: any = await CallRecording.findOneAndUpdate({ callLogId: call._id }, { $setOnInsert: {
    organizationId: String(call.orgId), callLogId: call._id, leadId: call.leadId, customerId: call.customerId, conversationId: call.conversationId,
    direction: call.direction, employeeId: String((call.answeredBy || call.placedBy)?.userId || ''), policy,
    controlId: call.direction === 'inbound' ? call.providerCallControlId : call.recordingCorrelation.answerControlId,
    sessionId: call.providerCallSessionId, legId: call.direction === 'inbound' ? call.recordingCorrelation.customerLegId : call.recordingCorrelation.legId,
  } }, { upsert: true, new: true });
  if (record.state === 'waiting') {
    if (policy.disclosureOwner === 'suprah') {
      const reserved = await change(record, 'disclosing');
      if (!reserved) return;
      try {
        await recordingAudit({ orgId: record.organizationId }, 'disclosure.requested', record._id, { policyVersion: policy.version });
        const tag = { ...decodeRecordingState(call.recordingCorrelation.clientState), recordingDisclosureId: String(record._id) };
        await telnyx.recordingDisclosure(record.controlId, policy.disclosureText, policy.disclosureLanguage, `recording-disclosure-${record._id}`, Buffer.from(JSON.stringify(tag)).toString('base64'));
      } catch (err) { await markFailure(record, err); }
      return;
    }
    await change(record, policy.consentMode === 'staff-confirmed' ? 'awaiting-consent' : 'starting', { disclosureCompletedAt: new Date() });
  }
  await startReservedRecording(record._id);
}

async function startReservedRecording(id: unknown) {
  const record: any = await CallRecording.findById(id);
  if (!record || record.state !== 'starting' || record.manualPaused) return;
  const call: any = await CallLog.findById(record.callLogId).select('+recordingCorrelation');
  if (!call || ['completed', 'canceled', 'missed', 'failed'].includes(call.status) || !await policyFor(call)) return markFailure(record, new Error('Recording cannot start on an ended or disabled call'));
  const reserved = await change(record, 'start-pending', { startedAt: new Date(), error: '' });
  if (!reserved) return;
  try {
    await recordingAudit({ orgId: record.organizationId }, 'recording.start-requested', record._id);
    await telnyx.recordingCommand(record.controlId, 'start', `recording-start-${record._id}`);
    await change(reserved, 'recording');
  } catch (err) {
    await markFailure(record, err);
    await telnyx.recordingCommand(record.controlId, 'stop', `recording-start-failure-stop-${record._id}`).catch(() => {});
  }
}

export async function recordingOwnCall(principal: RecordingPrincipal, callId: string) {
  await requireRecordingPermission(principal, 'control');
  const call: any = await CallLog.findOne({ _id: callId, orgId: principal.orgId });
  if (!call || String((call.answeredBy || call.placedBy)?.userId) !== principal.id || call.status !== 'in-progress') throw new ApiError(403, 'Only the connected rep may control recording');
  const record: any = await CallRecording.findOne({ callLogId: call._id, organizationId: principal.orgId });
  if (!record) throw new ApiError(409, 'Recording is not available for this call');
  return record;
}

export async function controlRecording(principal: RecordingPrincipal, callId: string, action: 'pause' | 'resume' | 'consent') {
  const record = await recordingOwnCall(principal, callId);
  if (action === 'consent') {
    if (record.state !== 'awaiting-consent') throw new ApiError(409, 'Consent is not pending');
    await recordingAudit(principal, 'consent.confirmed', record._id, { policyVersion: record.policy.version });
    const next = await change(record, 'starting', { consentConfirmedAt: new Date(), consentConfirmedBy: principal.id });
    if (next) await startReservedRecording(next._id);
    return;
  }
  if ((action === 'pause' && record.state !== 'recording') || (action === 'resume' && record.state !== 'paused')) throw new ApiError(409, 'Recording control is pending or unavailable');
  if (action === 'resume' && !await policyFor(await CallLog.findById(record.callLogId))) throw new ApiError(409, 'Recording policy is disabled');
  await recordingAudit(principal, `${action}.requested`, record._id);
  const next = await change(record, action === 'pause' ? 'pausing' : 'resuming', { ...(action === 'pause' ? { manualPaused: true } : {}) });
  if (!next) throw new ApiError(409, 'Another control is in progress');
  try {
    await telnyx.recordingCommand(record.controlId, action, `recording-${record._id}-${next.revision}-${action}`);
    await CallRecording.updateOne({ _id: next._id, revision: next.revision, state: next.state }, { $set: { state: action === 'pause' ? 'paused' : 'recording', manualPaused: action === 'pause', error: '' }, $push: { intervals: { action, at: new Date(), actorId: principal.id, revision: next.revision } } });
    await recordingAudit(principal, `${action}.accepted`, record._id);
  } catch (err) {
    await CallRecording.updateOne({ _id: next._id, revision: next.revision, state: next.state }, { $set: { state: 'unknown', incomplete: true, manualPaused: true, error: 'Provider control could not be established; do not discuss sensitive information' } });
    await recordingAudit(principal, `${action}.failed`, record._id);
    if (action === 'pause') await telnyx.recordingCommand(record.controlId, 'stop', `recording-emergency-stop-${record._id}-${next.revision}`).catch(() => {});
    throw new ApiError(502, 'Recording state is unknown; do not discuss sensitive information');
  }
}

export async function observeRecordingCall(type: string, payload: any) {
  const call = await locate(payload);
  if (!call) return;
  const policy = await policyFor(call, false);
  if (!policy?.connectionId) return;
  const tag = decodeRecordingState(payload.client_state);
  const taggedAgent = call.direction === 'inbound' && tag?.kind === 'agent-leg';
  if (!taggedAgent && policy.connectionId !== payload.connection_id) return;
  if (taggedAgent && !call.recordingCorrelation?.connectionId) throw new Error('Customer connection evidence is pending');
  if (taggedAgent && policy.connectionId !== call.recordingCorrelation?.connectionId) return;
  const update: any = { 'recordingCorrelation.connectionId': policy.connectionId };
  if (type === 'call.hangup') {
    if (![call.providerCallControlId, call.agentLegCallControlId, call.recordingCorrelation?.answerControlId].includes(payload.call_control_id)) return;
    if (call.direction === 'outbound' && call.recordingCorrelation?.verified && !call.endedAt) {
      call.endedAt = new Date();
      await CallLog.updateOne({ _id: call._id }, { $set: { status: call.answeredAt ? 'completed' : 'failed', endedAt: call.endedAt, hangupCause: payload.hangup_cause, durationSec: call.answeredAt ? Math.max(0, Math.round((call.endedAt.getTime() - call.answeredAt.getTime()) / 1000)) : 0 } });
    }
    const record: any = await CallRecording.findOne({ callLogId: call._id });
    if (record && !['deleted', 'deleting'].includes(record.state)) {
      await CallRecording.updateOne({ _id: record._id }, { $set: { state: record.files.length ? 'ready' : record.startedAt ? 'processing' : 'failed', endedAt: call.endedAt || new Date(), expiresAt: addCalendarMonths(call.endedAt || new Date(), record.policy.retentionMonths), ...(record.startedAt ? {} : { incomplete: true, error: 'Call ended before recording started' }) } });
    }
    return;
  }
  if (call.direction === 'outbound' && (tag?.kind === 'recording-outbound' || (call.recordingCorrelation?.verified && call.providerCallControlId === payload.call_control_id))) {
    if (call.providerCallSessionId && call.providerCallSessionId !== payload.call_session_id) return;
    if (call.providerCallControlId && call.providerCallControlId !== payload.call_control_id) return;
    Object.assign(update, { providerCallSessionId: payload.call_session_id, providerCallControlId: payload.call_control_id, 'recordingCorrelation.verified': true, 'recordingCorrelation.legId': payload.call_leg_id, ...(payload.client_state ? { 'recordingCorrelation.clientState': payload.client_state } : {}) });
    if (type === 'call.answered') {
      update['recordingCorrelation.answerControlId'] = payload.call_control_id;
      if (!call.endedAt) { update.status = 'in-progress'; update.answeredAt = call.answeredAt || new Date(); }
    }
  } else if (call.direction === 'inbound') {
    if (type === 'call.initiated' && payload.call_control_id === call.providerCallControlId) {
      await CallLog.updateOne({ _id: call._id }, { $set: { ...update, 'recordingCorrelation.customerLegId': payload.call_leg_id, 'recordingCorrelation.clientState': payload.client_state } });
      return;
    }
    const agentMatches = tag?.kind === 'agent-leg' && tag.callLogId === String(call._id) && String(tag.userId) === String(call.answeredBy?.userId) && (!call.routing || tag.revision === call.routing.revision);
    const customerBridge = type === 'call.bridged' && payload.call_control_id === call.providerCallControlId && call.recordingCorrelation?.answerControlId === call.agentLegCallControlId && call.status === 'in-progress';
    if (!agentMatches && !customerBridge) return;
    if (type === 'call.answered') Object.assign(update, { 'recordingCorrelation.answerControlId': payload.call_control_id, 'recordingCorrelation.verified': true, 'recordingCorrelation.legId': payload.call_leg_id });
    if (type === 'call.bridged') update['recordingCorrelation.bridged'] = true;
  }
  await CallLog.updateOne({ _id: call._id }, { $set: update });
  await maybeStartRecording(String(call._id));
}

export async function finishRecordingDisclosure(payload: any): Promise<boolean> {
  const tag = decodeRecordingState(payload.client_state);
  if (!tag?.recordingDisclosureId) return false;
  if (!/^[a-f0-9]{24}$/i.test(tag.recordingDisclosureId)) return true;
  const record: any = await CallRecording.findOne({ _id: tag.recordingDisclosureId, controlId: payload.call_control_id, state: 'disclosing' });
  if (!record) return true;
  if (payload.status && payload.status !== 'completed') { await markFailure(record, new Error('Recording disclosure did not complete')); return true; }
  const next = await change(record, record.policy.consentMode === 'staff-confirmed' ? 'awaiting-consent' : 'starting', { disclosureCompletedAt: new Date() });
  if (next) await startReservedRecording(next._id);
  return true;
}

async function importSaved(event: any) {
  const payload = event.payload;
  const record: any = await CallRecording.findOne({ sessionId: payload.call_session_id, ...(payload.call_leg_id ? { legId: payload.call_leg_id } : {}) });
  if (!record) throw new Error('Recording event has no verified call association');
  if (['deleting', 'deleted'].includes(record.state) || record.files.some((file: any) => file.eventId === event.eventId || (payload.recording_id && file.providerId === payload.recording_id))) return;
  if (payload.connection_id !== record.policy.connectionId) throw new Error('Recording connection mismatch');
  if (event.type === 'call.recording.error') { await markFailure(record, new Error('Provider failed to save the recording')); return; }
  const startedAt = new Date(payload.recording_started_at);
  const endedAt = new Date(payload.recording_ended_at);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime()) || !record.startedAt || startedAt.getTime() < record.startedAt.getTime() - 2000 || endedAt < startedAt) throw new Error('Recording coverage timestamps are invalid');
  if (addCalendarMonths(endedAt, record.policy.retentionMonths) <= new Date()) return;
  const recordings = await telnyx.findRecordings(record.sessionId);
  const found = recordings.find((item: any) => item.call_leg_id === payload.call_leg_id && Math.abs(new Date(item.recording_started_at).getTime() - startedAt.getTime()) < 2000);
  const providerId = payload.recording_id || found?.id;
  if (!providerId) throw new Error('Provider recording identity is unavailable');
  if (record.files.some((file: any) => file.providerId === providerId)) return;
  const url = found?.download_urls?.mp3 || payload.recording_urls?.mp3;
  if (!url) throw new Error('MP3 recording file is unavailable');
  const key = `call-recordings/${record.organizationId}/${record._id}/${hashToken(providerId)}.mp3`;
  await CallRecording.updateOne({ _id: record._id, state: { $nin: ['deleting', 'deleted'] }, 'pendingFiles.providerId': { $ne: providerId } }, { $push: { pendingFiles: { providerId, key } } });
  const currentRecord: any = await CallRecording.findById(record._id);
  if (!currentRecord || ['deleting', 'deleted'].includes(currentRecord.state)) return;
  const imported = await media.importRecordingFile(url, key);
  const call: any = await CallLog.findById(record.callLogId);
  const expiryBase = call?.endedAt || endedAt;
  const next = await CallRecording.findOneAndUpdate({ _id: record._id, state: { $nin: ['deleting', 'deleted'] }, 'files.providerId': { $ne: providerId } }, {
    $set: { ...(call?.endedAt ? { state: 'ready', endedAt: call.endedAt } : {}), expiresAt: addCalendarMonths(expiryBase, record.policy.retentionMonths) },
    $push: { files: { eventId: event.eventId, providerId, legId: payload.call_leg_id, key, ...imported, startedAt, endedAt } },
    $pull: { pendingFiles: { providerId } },
  }, { new: true });
  if (!next) {
    const current: any = await CallRecording.findById(record._id);
    if (!current?.files.some((file: any) => file.key === key)) await media.deleteRecordingFile(key);
  }
}

export async function deleteRecording(record: any, principal?: RecordingPrincipal) {
  record = await CallRecording.findOneAndUpdate({ _id: record._id }, { $set: { state: 'deleting' } }, { new: true });
  await CallRecordingShare.updateMany({ recordingId: record._id }, { $set: { revokedAt: new Date() } });
  for (const file of [...record.files, ...(record.pendingFiles || [])]) {
    await media.deleteRecordingFile(file.key);
    await telnyx.deleteProviderRecording(file.providerId).catch((err: any) => { if (err.status !== 404) throw err; });
  }
  if (record.startedAt) {
    const providerFiles = await telnyx.findRecordings(record.sessionId);
    for (const file of providerFiles.filter((f: any) => f.call_leg_id === record.legId && new Date(f.recording_started_at).getTime() >= record.startedAt.getTime() - 2000)) {
      await media.deleteRecordingFile(`call-recordings/${record.organizationId}/${record._id}/${hashToken(file.id)}.mp3`);
      await telnyx.deleteProviderRecording(file.id).catch((err: any) => { if (err.status !== 404) throw err; });
    }
  }
  await CallRecording.updateOne({ _id: record._id }, { $set: { state: 'deleted', deletedAt: new Date() }, $unset: { error: '' } });
  await recordingAudit(principal || { orgId: record.organizationId }, 'recording.deleted', record._id);
}

let working = false;
export async function recoverRecordings(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let i = 0; i < 20; i++) {
      const event: any = await CallRecordingEvent.findOneAndUpdate({ attempts: { $lt: 8 }, nextAttemptAt: { $lte: new Date() }, $or: [{ state: 'pending' }, { state: 'working', leaseUntil: { $lte: new Date() } }] }, { $set: { state: 'working', leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } });
      if (!event) break;
      try {
        if (event.type.startsWith('call.recording.')) await importSaved(event);
        else if (event.type === 'call.speak.ended') await finishRecordingDisclosure(event.payload);
        else await observeRecordingCall(event.type, event.payload);
        await CallRecordingEvent.updateOne({ _id: event._id }, { $set: { state: 'done' }, $unset: { payload: '', error: '' } });
      } catch (err) {
        if (event.type.startsWith('call.recording.')) await CallRecording.updateOne({ sessionId: event.payload.call_session_id, legId: event.payload.call_leg_id, state: { $nin: ['deleted', 'deleting'] } }, { $set: { incomplete: true, error: 'Recording import failed; recovery pending', ...(event.attempts >= 8 ? { state: 'failed' } : {}) } });
        await CallRecordingEvent.updateOne({ _id: event._id }, { $set: { state: event.attempts >= 8 ? 'failed' : 'pending', nextAttemptAt: new Date(Date.now() + Math.min(3600000, 10000 * 2 ** event.attempts)), error: err instanceof Error ? err.message.slice(0, 300) : 'Processing failed' } });
      }
    }
    const pending: any[] = await CallRecording.find({ state: 'processing', reconcileAttempts: { $lt: 8 }, $or: [{ nextReconcileAt: { $exists: false } }, { nextReconcileAt: { $lte: new Date() } }] }).limit(10);
    for (const record of pending) {
      await CallRecording.updateOne({ _id: record._id }, { $inc: { reconcileAttempts: 1 }, $set: { nextReconcileAt: new Date(Date.now() + 60000) } });
      try {
        const files = await telnyx.findRecordings(record.sessionId);
        for (const file of files.filter((f: any) => f.call_leg_id === record.legId)) await enqueueRecordingEvent(`reconcile-${file.id}`, 'call.recording.saved', { ...file, recording_id: file.id, connection_id: record.policy.connectionId, call_session_id: record.sessionId, recording_urls: file.download_urls });
        if (record.reconcileAttempts >= 7) await markFailure(record, new Error('Recording file unavailable after reconciliation'));
      } catch (err) { if (record.reconcileAttempts >= 7) await markFailure(record, err); }
    }
    const expired: any[] = await CallRecording.find({ $or: [{ state: 'deleting' }, { expiresAt: { $lte: new Date() }, state: { $nin: ['deleted', 'recording', 'paused', 'starting', 'disclosing'] } }] }).limit(20);
    for (const record of expired) await deleteRecording(record).catch(() => {});
    const stale: any[] = await CallRecording.find({ state: { $in: ['disclosing', 'pausing', 'resuming', 'starting', 'start-pending'] }, updatedAt: { $lt: new Date(Date.now() - 60000) } }).limit(20);
    for (const record of stale) await markFailure(record, new Error('Recording operation timed out; coverage is incomplete'));
  } finally { working = false; }
}
