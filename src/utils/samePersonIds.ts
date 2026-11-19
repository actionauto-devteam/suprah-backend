import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';

export async function samePersonIds(organizationId: string, id: string): Promise<string[]> {
  if (!id) return [];
  const person: any = (await User.findOne({ _id: id, organizationId }).select('email').lean())
    || (await CrmUser.findOne({ _id: id, organizationId }).select('email').lean());
  const email = String(person?.email || '').trim().toLowerCase();
  if (!email) return [id];
  const [mainUsers, crmUsers] = await Promise.all([
    User.find({ organizationId, email }).select('_id').lean(),
    CrmUser.find({ organizationId, email }).select('_id').lean(),
  ]);
  return [...new Set([id, ...[...mainUsers, ...crmUsers].map((row: any) => String(row._id))])];
}
