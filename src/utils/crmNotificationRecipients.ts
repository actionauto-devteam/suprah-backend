import mongoose from 'mongoose';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';

export async function crmNotificationRecipients(organizationId: string, userIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(userIds.map(String).filter(Boolean)));
  if (!ids.length) return [];
  const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
  const mainUsers = validIds.length
    ? await User.find({ _id: { $in: validIds }, organizationId, isActive: true }).select('_id email').lean()
    : [];
  const emails = (mainUsers as any[]).map((user) => user.email?.toLowerCase()).filter(Boolean);
  const linked = emails.length
    ? await CrmUser.find({ organizationId, isActive: true, isOffboarded: { $ne: true }, email: { $in: emails } }).select('_id email').lean()
    : [];
  const replacements = new Map((mainUsers as any[]).map((user) => [
    String(user._id),
    (linked as any[]).find((crm) => crm.email?.toLowerCase() === user.email?.toLowerCase())?._id,
  ]));
  return [...new Set(ids.map((id) => String(replacements.get(id) || id)))];
}
