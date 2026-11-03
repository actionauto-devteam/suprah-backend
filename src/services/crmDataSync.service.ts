import mongoose from 'mongoose';
import CrmDataSync, { CRM_DATA_SYNC_TYPES } from '../models/CrmDataSync.model';
import { CrmAutomationActorRef } from '../models/CrmAutomation.model';
import { ApiError } from '../utils/ApiError';
import { cleanAutomationLocations } from './crmAutomation.service';

const MAX_NAME = 120;
const MAX_LIST = 200;

function bad(message: string): never {
  throw new ApiError(400, message);
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) bad('Give the data sync a name');
  if (name.length > MAX_NAME) bad(`Keep the name under ${MAX_NAME} characters`);
  return name;
}

function cleanStatus(value: unknown): 'active' | 'inactive' {
  if (value === undefined) return 'active';
  if (value !== 'active' && value !== 'inactive') bad('Choose Active or Inactive');
  return value;
}

function serialize(doc: any) {
  return {
    id: String(doc._id),
    type: doc.type,
    name: doc.name,
    status: doc.status,
    locations: { mode: doc.locations?.mode || 'all', ids: doc.locations?.ids || [] },
    setupComplete: Boolean(doc.setupComplete),
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function loadOwned(orgId: string, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Data sync not found');
  const doc = await CrmDataSync.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new ApiError(404, 'Data sync not found');
  return doc;
}

export async function listDataSyncs(orgId: string) {
  const docs = await CrmDataSync.find({ organizationId: orgId }).sort({ updatedAt: -1 }).limit(MAX_LIST).lean();
  return docs.map(serialize);
}

export async function getDataSync(orgId: string, id: string) {
  return serialize((await loadOwned(orgId, id)).toObject());
}

export async function createDataSync(orgId: string, actor: CrmAutomationActorRef, input: any) {
  const type = (CRM_DATA_SYNC_TYPES as readonly string[]).includes(input?.type) ? input.type : bad('Choose a data sync type');
  const doc = await CrmDataSync.create({
    organizationId: orgId,
    type,
    name: cleanName(input?.name),
    status: cleanStatus(input?.status),
    locations: await cleanAutomationLocations(orgId, input?.locations),
    setupComplete: false,
    createdBy: actor,
    updatedBy: actor,
  });
  return serialize(doc.toObject());
}

export async function updateDataSync(orgId: string, actor: CrmAutomationActorRef, id: string, input: any) {
  const doc = await loadOwned(orgId, id);
  if (input?.name !== undefined) doc.name = cleanName(input.name);
  if (input?.status !== undefined) doc.status = cleanStatus(input.status);
  if (input?.locations !== undefined) doc.locations = await cleanAutomationLocations(orgId, input.locations);
  doc.updatedBy = actor;
  await doc.save();
  return serialize(doc.toObject());
}

export async function deleteDataSync(orgId: string, id: string) {
  const doc = await loadOwned(orgId, id);
  await doc.deleteOne();
}
