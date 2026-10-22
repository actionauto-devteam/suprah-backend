import mongoose, { ClientSession } from 'mongoose';
import AiKnowledgeEntry, { type KnowledgePendingAudit } from '../models/AiKnowledgeEntry.model';
import AiKnowledgeAuditLog, { type KnowledgeAuditAction } from '../models/AiKnowledgeAuditLog.model';
import type { TrainingActorRef } from '../models/AiTrainingPolicy.model';
import logger from '../utils/logger';

export const KNOWLEDGE_NOTE_LIMIT = 500;

const AUDIT_FIELDS = ['version', 'fromStatus', 'toStatus', 'fromLifecycle', 'toLifecycle', 'detailId', 'locationId'] as const;

type AuditExtra = Partial<Pick<KnowledgePendingAudit, (typeof AUDIT_FIELDS)[number] | 'note'>>;

const isDuplicateKeyError = (err: any) => err?.code === 11000 || /E11000/.test(String(err?.message || ''));

export function knowledgeAuditEntry(action: KnowledgeAuditAction, actor: TrainingActorRef, extra: AuditExtra = {}): KnowledgePendingAudit {
  const entry: KnowledgePendingAudit = { _id: new mongoose.Types.ObjectId(), action, actor, createdAt: new Date() };
  for (const key of AUDIT_FIELDS) {
    if (extra[key] !== undefined && extra[key] !== null) (entry as any)[key] = extra[key];
  }
  if (extra.note) entry.note = String(extra.note).slice(0, KNOWLEDGE_NOTE_LIMIT);
  return entry;
}

function auditRow(organizationId: string, entryId: any, entry: any) {
  const row: Record<string, unknown> = { _id: entry._id, organizationId, entryId, action: entry.action, actor: entry.actor, createdAt: entry.createdAt };
  for (const key of [...AUDIT_FIELDS, 'note']) {
    if (entry[key] !== undefined && entry[key] !== null) row[key] = entry[key];
  }
  return row;
}

export async function flushKnowledgeAudit(organizationId: string, entryId: any): Promise<boolean> {
  try {
    const entry: any = await AiKnowledgeEntry.findOne({ _id: entryId, organizationId }).select('pendingAudit').lean();
    const pending: any[] = entry?.pendingAudit || [];
    if (!pending.length) return true;
    for (const item of pending) {
      try {
        await AiKnowledgeAuditLog.collection.insertOne(auditRow(organizationId, entry._id, item) as any);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    await AiKnowledgeEntry.updateOne(
      { _id: entry._id, organizationId },
      { $pull: { pendingAudit: { _id: { $in: pending.map((item) => item._id) } } } },
    );
    return true;
  } catch (err: any) {
    logger.warn({ organizationId, entryId: String(entryId), errorName: err?.name }, '[KnowledgeBase] Audit outbox flush deferred; entries stay on the entry until the next write');
    return false;
  }
}

export async function flushKnowledgeAuditMany(organizationId: string, entryIds: any[]): Promise<void> {
  for (const entryId of entryIds) await flushKnowledgeAudit(organizationId, entryId);
}

export async function writeKnowledgeAudit(input: {
  organizationId: string;
  action: KnowledgeAuditAction;
  actor: TrainingActorRef;
  detailId?: any;
  locationId?: any;
  version?: number;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  session: ClientSession | null;
}): Promise<void> {
  const { session, note, ...fields } = input;
  await AiKnowledgeAuditLog.create(
    [{ ...fields, ...(note ? { note: String(note).slice(0, KNOWLEDGE_NOTE_LIMIT) } : {}) }],
    session ? { session } : {},
  );
}
