import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';

// Bridges presence (onlineStatus/away/busy/DND/deviceType) between the two independent
// account models — `User` (main site, holds the real onlineStatus/statusIsManual pipeline)
// and `CrmUser` (CRM-only identity, e.g. SupraSpace, no presence fields of its own). Linked
// solely by email+org, same pattern as locator.controller.ts's syncLinkedAccountConsent.

export async function resolveCrmUserIdByEmail(email: string, organizationId?: any): Promise<string | null> {
  if (!email) return null;
  const query: any = { email: email.toLowerCase() };
  if (organizationId) query.organizationId = organizationId;
  const crmUser = await CrmUser.findOne(query).select('_id').lean();
  return crmUser ? (crmUser._id as any).toString() : null;
}

export interface ResolvedPresence {
  onlineStatus: string;
  customStatus?: string | null;
  lastDeviceType?: 'mobile' | 'desktop' | null;
  statusExpiresAt?: Date | null;
}

export async function resolvePresenceForCrmRoster(
  crmUsers: Array<{ _id: any; email?: string }>,
): Promise<Map<string, ResolvedPresence>> {
  const result = new Map<string, ResolvedPresence>();
  const emails = crmUsers.map((u) => u.email?.toLowerCase()).filter(Boolean) as string[];
  if (!emails.length) return result;

  const linkedUsers = await User.find({ email: { $in: emails } })
    .select('email onlineStatus customStatus lastDeviceType statusExpiresAt')
    .lean();
  const byEmail = new Map(linkedUsers.map((u) => [u.email.toLowerCase(), u]));

  for (const cu of crmUsers) {
    const match = cu.email ? byEmail.get(cu.email.toLowerCase()) : undefined;
    result.set(cu._id.toString(), {
      onlineStatus: match?.onlineStatus || 'offline',
      customStatus: match?.customStatus ?? null,
      lastDeviceType: match?.lastDeviceType ?? null,
      statusExpiresAt: match?.statusExpiresAt ?? null,
    });
  }
  return result;
}
