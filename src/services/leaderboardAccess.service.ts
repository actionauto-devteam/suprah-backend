import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import LeaderboardAccess from '../models/LeaderboardAccess.model';
import { ApiError } from '../utils/ApiError';
import { recordingPrincipal, RecordingPrincipal } from './callRecordingAccess.service';

export type LeaderboardViewer = RecordingPrincipal;

export interface LeaderboardStaffRow {
  id: string;
  kind: 'crm' | 'main';
  name: string;
  email: string;
  role: string;
  avatar: string;
  isAdmin: boolean;
  allowed: boolean;
}

const STAFF_ROLES = ['employee', 'admin', 'super_admin'];

export async function leaderboardViewer(id: string, orgId: string): Promise<LeaderboardViewer> {
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(orgId)) throw new ApiError(403, 'Active staff identity required');
  return recordingPrincipal(id, orgId);
}

export async function canViewLeaderboard(viewer: LeaderboardViewer): Promise<boolean> {
  if (viewer.admin) return true;
  const grant = await LeaderboardAccess.exists({
    organizationId: viewer.orgId,
    principalId: viewer.id,
    principalKind: viewer.kind,
    allowed: true,
  });
  return Boolean(grant);
}

export async function requireLeaderboardAccess(viewer: LeaderboardViewer): Promise<void> {
  if (!(await canViewLeaderboard(viewer))) {
    throw new ApiError(403, 'You do not have access to the Leaderboard. Ask an admin to give you access.');
  }
}

export async function listLeaderboardStaff(orgId: string): Promise<LeaderboardStaffRow[]> {
  const orgObjectId = new mongoose.Types.ObjectId(orgId);
  const [crmUsers, grants] = await Promise.all([
    CrmUser.find({ organizationId: orgObjectId, isActive: true, isSystem: { $ne: true }, isOffboarded: { $ne: true } })
      .select('fullName email role avatar')
      .lean(),
    LeaderboardAccess.find({ organizationId: orgId, allowed: true }).select('principalId principalKind').lean(),
  ]);
  const crmEmails = new Set((crmUsers as any[]).map((user) => String(user.email || '').toLowerCase()));
  const mainUsers = await User.find({ organizationId: orgObjectId, isActive: true, role: { $in: STAFF_ROLES } })
    .select('name email role organizationRole avatar')
    .lean();
  const allowed = new Set((grants as any[]).map((grant) => `${grant.principalKind}:${grant.principalId}`));

  const rows: LeaderboardStaffRow[] = [
    ...(crmUsers as any[]).map((user) => ({
      id: String(user._id),
      kind: 'crm' as const,
      name: String(user.fullName || user.email || 'Team member'),
      email: String(user.email || ''),
      role: String(user.role || 'employee'),
      avatar: String(user.avatar || ''),
      isAdmin: user.role === 'admin',
      allowed: user.role === 'admin' || allowed.has(`crm:${String(user._id)}`),
    })),
    ...(mainUsers as any[])
      .filter((user) => !crmEmails.has(String(user.email || '').toLowerCase()))
      .map((user) => {
        const isAdmin = ['admin', 'super_admin'].includes(user.role) || user.organizationRole === 'admin';
        return {
          id: String(user._id),
          kind: 'main' as const,
          name: String(user.name || user.email || 'Team member'),
          email: String(user.email || ''),
          role: isAdmin ? 'admin' : String(user.organizationRole || 'employee'),
          avatar: String(user.avatar || ''),
          isAdmin,
          allowed: isAdmin || allowed.has(`main:${String(user._id)}`),
        };
      }),
  ];

  return rows.sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name));
}

export async function setLeaderboardAccess(input: {
  admin: LeaderboardViewer;
  principalId: string;
  principalKind: 'crm' | 'main';
  allowed: boolean;
}): Promise<void> {
  if (!input.admin.admin) throw new ApiError(403, 'Only admins can change who can see the Leaderboard');
  if (!mongoose.isValidObjectId(input.principalId)) throw new ApiError(400, 'Invalid team member');
  const target = await recordingPrincipal(input.principalId, input.admin.orgId, input.principalKind);
  if (target.admin) throw new ApiError(400, 'Admins can always see the Leaderboard');
  await LeaderboardAccess.updateOne(
    { organizationId: input.admin.orgId, principalId: target.id, principalKind: target.kind },
    { $set: { allowed: input.allowed, updatedBy: input.admin.id } },
    { upsert: true },
  );
}
