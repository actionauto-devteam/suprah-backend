import mongoose from 'mongoose';
import User from '../models/User.model';
import Session from '../models/Session.model';
import Organization from '../models/Organization.model';
import { invalidateUserCache } from '../utils/cache.util';

export type MainAccountSuspendStatus = 'suspended' | 'none' | 'protected' | 'other_organization' | 'already_suspended';

interface LinkedCrmIdentity {
  email?: string | null;
  organizationId?: mongoose.Types.ObjectId | string | null;
}

async function findLinkedMainUser(crmUser: LinkedCrmIdentity) {
  if (!crmUser.email) return null;
  return User.findOne({ email: crmUser.email.trim().toLowerCase() });
}

function belongsToSameOrganization(mainOrgId: unknown, crmOrgId: unknown): boolean {
  return !mainOrgId || (!!crmOrgId && String(mainOrgId) === String(crmOrgId));
}

export async function suspendLinkedMainAccount(crmUser: LinkedCrmIdentity): Promise<MainAccountSuspendStatus> {
  const mainUser = await findLinkedMainUser(crmUser);
  if (!mainUser) return 'none';
  if (!belongsToSameOrganization(mainUser.organizationId, crmUser.organizationId)) return 'other_organization';

  if (mainUser.role === 'super_admin' || mainUser.organizationRole === 'owner') return 'protected';
  const org = mainUser.organizationId
    ? await Organization.findById(mainUser.organizationId).select('ownerId').lean()
    : null;
  if (org?.ownerId && String(org.ownerId) === String(mainUser._id)) return 'protected';

  if (!mainUser.isActive && !mainUser.suspendedByOffboard) return 'already_suspended';

  mainUser.isActive = false;
  mainUser.suspendedByOffboard = true;
  await mainUser.save({ validateModifiedOnly: true });

  await Session.updateMany(
    { userId: mainUser._id, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  invalidateUserCache(String(mainUser._id));

  return 'suspended';
}

export async function restoreLinkedMainAccount(crmUser: LinkedCrmIdentity): Promise<boolean> {
  const mainUser = await findLinkedMainUser(crmUser);
  if (!mainUser || !mainUser.suspendedByOffboard) return false;

  mainUser.isActive = true;
  mainUser.suspendedByOffboard = undefined;
  await mainUser.save({ validateModifiedOnly: true });
  invalidateUserCache(String(mainUser._id));

  return true;
}
