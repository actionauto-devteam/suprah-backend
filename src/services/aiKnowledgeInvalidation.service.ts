import crypto from 'crypto';
import { ClientSession } from 'mongoose';
import AiKnowledgeEntry, { type KnowledgeInvalidationReason } from '../models/AiKnowledgeEntry.model';
import AiKnowledgeVerifiedDetail from '../models/AiKnowledgeVerifiedDetail.model';
import AiKnowledgeKeyLock from '../models/AiKnowledgeKeyLock.model';
import type { TrainingActorRef } from '../models/AiTrainingPolicy.model';
import { knowledgeAuditEntry, writeKnowledgeAudit } from './aiKnowledgeAudit';

const withSession = (session: ClientSession | null) => (session ? { session } : {});

export async function lockKnowledgeLocations(organizationId: string, session: ClientSession | null): Promise<void> {
  await AiKnowledgeKeyLock.updateOne(
    { organizationId, keyHash: crypto.createHash('sha256').update(`locations|${organizationId}`, 'utf8').digest('hex') },
    { $inc: { seq: 1 } },
    { upsert: true, ...withSession(session) },
  );
}

export async function invalidateApprovalsForDetail(input: {
  organizationId: string;
  detailId: any;
  reason: KnowledgeInvalidationReason;
  actor: TrainingActorRef;
  session: ClientSession | null;
}): Promise<string[]> {
  const rows: any[] = await AiKnowledgeEntry.find({
    organizationId: input.organizationId,
    approvedVersion: { $gte: 1 },
    'approvedDependencies.detailId': input.detailId,
    approvalInvalidation: { $exists: false },
  }).select('_id approvedVersion').session(input.session).lean();
  const touched: string[] = [];
  const at = new Date();
  for (const row of rows) {
    const result = await AiKnowledgeEntry.updateOne(
      { _id: row._id, organizationId: input.organizationId, approvalInvalidation: { $exists: false } },
      {
        $set: { approvalInvalidation: { reason: input.reason, at, detailId: input.detailId, by: input.actor } },
        $push: { pendingAudit: knowledgeAuditEntry('approval_invalidated', input.actor, { version: row.approvedVersion, detailId: input.detailId, note: input.reason }) },
      },
      withSession(input.session),
    );
    if (result.modifiedCount) touched.push(String(row._id));
  }
  return touched;
}

const coversLocation = (field: string, locationId: any) => ({
  $or: [{ [`${field}.scope`]: 'all' }, { [`${field}.scope`]: 'locations', [`${field}.locationIds`]: locationId }],
});

export async function suspendKnowledgeForLocation(input: {
  organizationId: string;
  locationId: any;
  cause: 'location_archived' | 'location_restored';
  actor: TrainingActorRef;
  session: ClientSession | null;
}): Promise<string[]> {
  await lockKnowledgeLocations(input.organizationId, input.session);
  const rows: any[] = await AiKnowledgeEntry.find({
    organizationId: input.organizationId,
    approvedVersion: { $gte: 1 },
    approvalSuspendedLocationIds: { $ne: input.locationId },
    ...coversLocation('approvedLocationScope', input.locationId),
  }).select('_id approvedVersion').session(input.session).lean();
  const touched: string[] = [];
  for (const row of rows) {
    const result = await AiKnowledgeEntry.updateOne(
      { _id: row._id, organizationId: input.organizationId, approvalSuspendedLocationIds: { $ne: input.locationId } },
      {
        $addToSet: { approvalSuspendedLocationIds: input.locationId },
        $push: { pendingAudit: knowledgeAuditEntry('location_suspended', input.actor, { version: row.approvedVersion, locationId: input.locationId, note: input.cause }) },
      },
      withSession(input.session),
    );
    if (result.modifiedCount) touched.push(String(row._id));
  }
  const details: any[] = await AiKnowledgeVerifiedDetail.find({
    organizationId: input.organizationId,
    status: 'approved',
    suspendedLocationIds: { $ne: input.locationId },
    ...coversLocation('locationScope', input.locationId),
  }).select('_id revision').session(input.session).lean();
  for (const detail of details) {
    const result = await AiKnowledgeVerifiedDetail.updateOne(
      { _id: detail._id, organizationId: input.organizationId, status: 'approved', suspendedLocationIds: { $ne: input.locationId } },
      { $addToSet: { suspendedLocationIds: input.locationId } },
      withSession(input.session),
    );
    if (result.modifiedCount) {
      await writeKnowledgeAudit({
        organizationId: input.organizationId, action: 'detail_location_suspended', actor: input.actor, detailId: detail._id,
        locationId: input.locationId, version: detail.revision, note: input.cause, session: input.session,
      });
    }
  }
  return touched;
}
