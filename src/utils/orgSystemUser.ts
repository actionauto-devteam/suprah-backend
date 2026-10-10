import User from '../models/User.model';

export async function resolveOrgSystemUserId(orgId: unknown): Promise<string | null> {
  const systemUser = await User.findOne({
    organizationId: orgId,
    role: { $in: ['admin', 'employee'] },
  })
    .sort({ role: 1 })
    .select('_id')
    .lean();

  return systemUser ? String((systemUser as any)._id) : null;
}
