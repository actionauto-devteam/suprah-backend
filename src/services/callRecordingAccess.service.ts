import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import { CallRecordingGrant, CallRecordingAudit, RecordingPermission } from '../models/CallRecording.model';

export interface RecordingPrincipal { id: string; kind: 'crm' | 'main'; orgId: string; admin: boolean }

export async function recordingPrincipal(id: string, orgId: string, kind?: 'crm' | 'main'): Promise<RecordingPrincipal> {
  if (kind !== 'main') {
    const crm: any = await CrmUser.findOne({ _id: id, organizationId: orgId, isActive: true, isOffboarded: { $ne: true }, isSystem: { $ne: true } }).lean();
    if (crm) return { id, orgId, kind: 'crm', admin: crm.role === 'admin' };
    if (kind === 'crm') throw new ApiError(403, 'Active staff identity required');
  }
  const main: any = await User.findOne({ _id: id, organizationId: orgId, isActive: true, role: { $in: ['employee', 'admin', 'super_admin'] } }).lean();
  if (!main) throw new ApiError(403, 'Active staff identity required');
  return { id, orgId, kind: 'main', admin: ['admin', 'super_admin'].includes(main.role) || main.organizationRole === 'admin' };
}

export async function recordingPermissions(principal: RecordingPrincipal): Promise<RecordingPermission[]> {
  const grant: any = await CallRecordingGrant.findOne({ organizationId: principal.orgId, principalId: principal.id, principalKind: principal.kind }).lean();
  return grant?.permissions || [];
}

export async function requireRecordingPermission(principal: RecordingPrincipal, permission: RecordingPermission): Promise<void> {
  if (!(await recordingPermissions(principal)).includes(permission)) throw new ApiError(403, `Recording ${permission} permission required`);
}

export async function recordingAudit(principal: RecordingPrincipal | { orgId: string; id?: string; kind?: string }, action: string, recordingId?: unknown, detail?: unknown): Promise<void> {
  await CallRecordingAudit.create({ organizationId: principal.orgId, actorId: principal.id, actorKind: principal.kind || 'system', action, recordingId, detail });
}
