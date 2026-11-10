import mongoose from 'mongoose';
import User from '../models/User.model';
import { ApiError } from './ApiError';

export type CrmStaffRole = 'admin' | 'manager' | 'employee';

export interface CrmStaff {
  userId: string | null;
  actorId: string;
  name: string;
  role: CrmStaffRole;
}

export function orgIdVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

export function staffTeamQuery(orgId: string) {
  return { organizationId: { $in: orgIdVariants(orgId) }, role: { $in: ['employee', 'admin', 'super_admin'] }, isActive: { $ne: false } };
}

export function staffName(member: any): string {
  return String(member?.name || member?.email || 'Team member');
}

export async function resolveCrmStaff(orgId: string, crmUser: any): Promise<CrmStaff> {
  if (!crmUser?._id) throw new ApiError(401, 'Please authenticate');
  const role: CrmStaffRole = crmUser.role === 'admin' || crmUser.role === 'manager' ? crmUser.role : 'employee';
  const actorId = String(crmUser._id);
  const name = String(crmUser.fullName || crmUser.name || crmUser.email || 'Team member');
  let userId: string | null = null;
  if (mongoose.isValidObjectId(actorId) && (await User.exists({ _id: actorId, organizationId: { $in: orgIdVariants(orgId) } }))) {
    userId = actorId;
  } else if (crmUser.email) {
    const user: any = await User.findOne({ email: String(crmUser.email).trim().toLowerCase(), organizationId: { $in: orgIdVariants(orgId) } }).select('_id').lean();
    userId = user ? String(user._id) : null;
  }
  return { userId, actorId, name, role };
}

export function isManagerOrAdmin(staff: CrmStaff): boolean {
  return staff.role === 'admin' || staff.role === 'manager';
}

export async function listStaffTeam(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const members = await User.find(staffTeamQuery(orgId)).select('name email').sort({ name: 1 }).limit(500).lean();
  return members.map((member: any) => ({ id: String(member._id), name: staffName(member) }));
}

export async function requireTeamMember(orgId: string, userId: unknown): Promise<{ id: mongoose.Types.ObjectId; name: string } | null> {
  if (userId === null || userId === undefined || userId === '') return null;
  const id = String(userId);
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Pick a team member from the list');
  const member: any = await User.findOne({ _id: id, ...staffTeamQuery(orgId) }).select('name email').lean();
  if (!member) throw new ApiError(400, 'That team member is inactive or not on this team');
  return { id: new mongoose.Types.ObjectId(id), name: staffName(member) };
}
