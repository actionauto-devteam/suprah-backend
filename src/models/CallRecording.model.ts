import mongoose, { Schema } from 'mongoose';

export const RECORDING_PERMISSIONS = ['view', 'download', 'share', 'review', 'control', 'delete'] as const;
export type RecordingPermission = typeof RECORDING_PERMISSIONS[number];

const policy = new Schema({
  organizationId: { type: String, required: true }, name: { type: String, required: true },
  number: { type: String, required: true }, direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  enabled: { type: Boolean, default: false }, retentionMonths: { type: Number, default: 6 },
  connectionId: { type: String, default: '' }, legalApproved: { type: Boolean, default: false },
  providerVerified: { type: Boolean, default: false }, disclosureOwner: { type: String, enum: ['pending', 'suprah', 'provider'], default: 'pending' },
  disclosureText: { type: String, default: '' }, disclosureLanguage: { type: String, default: 'en-US' },
  providerDisclosureVerified: { type: Boolean, default: false }, consentMode: { type: String, enum: ['pending', 'notice', 'staff-confirmed'], default: 'pending' },
  version: { type: Number, default: 1 }, updatedBy: String,
}, { timestamps: true });
policy.index({ organizationId: 1, number: 1, direction: 1 }, { unique: true });

const recording = new Schema({
  organizationId: { type: String, required: true }, callLogId: { type: Schema.Types.ObjectId, required: true, unique: true },
  leadId: Schema.Types.ObjectId, conversationId: Schema.Types.ObjectId, customerId: Schema.Types.ObjectId,
  direction: String, employeeId: String, policy: Schema.Types.Mixed,
  state: { type: String, default: 'waiting', enum: ['waiting', 'disclosing', 'awaiting-consent', 'starting', 'start-pending', 'recording', 'pausing', 'paused', 'resuming', 'unknown', 'processing', 'ready', 'failed', 'deleting', 'deleted'] },
  revision: { type: Number, default: 0 }, controlId: String, sessionId: String, legId: String,
  manualPaused: { type: Boolean, default: false }, incomplete: { type: Boolean, default: false }, error: String,
  disclosureCompletedAt: Date, consentConfirmedAt: Date, consentConfirmedBy: String,
  startedAt: Date, endedAt: Date, expiresAt: Date, deletedAt: Date, nextReconcileAt: Date, reconcileAttempts: { type: Number, default: 0 },
  intervals: [{ action: String, at: Date, actorId: String, revision: Number }],
  files: [{ eventId: String, providerId: String, legId: String, key: String, bytes: Number, checksum: String, startedAt: Date, endedAt: Date }],
  pendingFiles: [new Schema({ providerId: String, key: String }, { _id: false })],
}, { timestamps: true });
recording.index({ expiresAt: 1, state: 1 });

const grant = new Schema({ organizationId: { type: String, required: true }, principalId: { type: String, required: true }, principalKind: { type: String, enum: ['crm', 'main'], required: true }, permissions: [{ type: String, enum: RECORDING_PERMISSIONS }], updatedBy: String }, { timestamps: true });
grant.index({ organizationId: 1, principalId: 1, principalKind: 1 }, { unique: true });
const audit = new Schema({ organizationId: { type: String, required: true }, recordingId: Schema.Types.ObjectId, actorId: String, actorKind: String, action: { type: String, required: true }, detail: Schema.Types.Mixed }, { timestamps: true });
audit.index({ organizationId: 1, recordingId: 1, createdAt: -1 });
const event = new Schema({ eventId: { type: String, unique: true, required: true }, type: String, payload: Schema.Types.Mixed, state: { type: String, default: 'pending' }, attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now }, leaseUntil: Date, error: String, purgeAt: { type: Date, default: () => new Date(Date.now() + 30 * 86400000) } }, { timestamps: true });
event.index({ state: 1, nextAttemptAt: 1 });
event.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
const share = new Schema({ organizationId: String, recordingId: Schema.Types.ObjectId, createdBy: String, expiresAt: Date, revokedAt: Date }, { timestamps: true });
const media = new Schema({ organizationId: String, recordingId: Schema.Types.ObjectId, fileId: String, principalId: String, principalKind: String, authKind: String, authSessionId: String, authUserId: String, mode: { type: String, enum: ['play', 'download'] }, tokenHash: { type: String, unique: true }, expiresAt: Date, shareId: Schema.Types.ObjectId }, { timestamps: true });
media.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CallRecordingPolicy = mongoose.models.CallRecordingPolicy || mongoose.model('CallRecordingPolicy', policy);
export const CallRecording = mongoose.models.CallRecording || mongoose.model('CallRecording', recording);
export const CallRecordingGrant = mongoose.models.CallRecordingGrant || mongoose.model('CallRecordingGrant', grant);
export const CallRecordingAudit = mongoose.models.CallRecordingAudit || mongoose.model('CallRecordingAudit', audit);
export const CallRecordingEvent = mongoose.models.CallRecordingEvent || mongoose.model('CallRecordingEvent', event);
export const CallRecordingShare = mongoose.models.CallRecordingShare || mongoose.model('CallRecordingShare', share);
export const CallRecordingMediaSession = mongoose.models.CallRecordingMediaSession || mongoose.model('CallRecordingMediaSession', media);
