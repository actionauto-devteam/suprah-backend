import User from '../models/User.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import { invalidateUserCache } from './cache.util';
import { emitToOrg } from './socketEmitter';

type CascadeParams = {
  email?: string | null;
  organizationId?: unknown;
  crmUserId?: unknown;
  department?: string | null;
};

// Mirrors syncLinkedAccountConsent (locator.controller.ts) for the department field: a
// physical person can have both a main-site `User` and a `CrmUser` account linked only by
// email. When an admin assigns a department on the CrmUser side, this pushes it onto the
// linked User's personalInfo.department (what Beacon's roster, Team Pulse, etc. all read)
// and refreshes any EmployeeLocation snapshot rows immediately, instead of waiting for the
// employee's device to ping again. Best-effort — never blocks the primary admin write.
export async function cascadeDepartmentToLinkedUser(params: CascadeParams): Promise<void> {
  const { email, organizationId, crmUserId, department } = params;
  if (!email) return;

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const linkedUser = await User.findOne({ email: normalizedEmail, organizationId });
    if (!linkedUser) return;

    await User.findByIdAndUpdate(linkedUser._id, {
      $set: { 'personalInfo.department': department || undefined },
    });
    invalidateUserCache((linkedUser._id as any).toString());

    const targetIds = [linkedUser._id, crmUserId].filter(Boolean);
    if (targetIds.length > 0) {
      await EmployeeLocation.updateMany(
        { userId: { $in: targetIds } },
        { $set: { department: department || undefined } },
      );
    }

    if (organizationId) {
      emitToOrg((organizationId as any).toString(), 'employee:department_changed', {
        userId: (linkedUser._id as any).toString(),
        crmUserId: crmUserId ? (crmUserId as any).toString() : undefined,
        department: department || undefined,
      });
    }
  } catch (error) {
    console.error('cascadeDepartmentToLinkedUser failed (best-effort, primary write already succeeded):', error);
  }
}
