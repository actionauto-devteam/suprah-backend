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

type EmailCascadeParams = {
  previousEmail?: string | null;
  nextEmail?: string | null;
  organizationId?: unknown;
};

// Same dual-account problem as cascadeDepartmentToLinkedUser above, but for the email address
// itself. CrmUser and User are linked ONLY by matching email (see getLocatorActor,
// getMainPersonalInfoByEmail, crmAuth.middleware's main-token fallback) — there is no schema
// reference between them. When an admin renames a CrmUser's email, the linked User document
// keeps the old address unless something pushes the new one onto it, which silently breaks the
// link: every downstream email-keyed lookup stops finding the account, and anything reading the
// person's email straight off the main User record (Team Pulse's roster, Locator, personalInfo
// enrichment) keeps showing the stale address indefinitely. Must run BEFORE
// cascadeDepartmentToLinkedUser so that call's own lookup-by-new-email succeeds too.
export async function cascadeEmailToLinkedUser(params: EmailCascadeParams): Promise<void> {
  const { previousEmail, nextEmail, organizationId } = params;
  const normalizedPrevious = previousEmail?.trim().toLowerCase();
  const normalizedNext = nextEmail?.trim().toLowerCase();
  if (!normalizedPrevious || !normalizedNext || normalizedPrevious === normalizedNext) return;

  try {
    const linkedUser = await User.findOne({ email: normalizedPrevious, organizationId });
    if (!linkedUser) return;

    const emailTaken = await User.exists({ email: normalizedNext, _id: { $ne: linkedUser._id } });
    if (emailTaken) {
      console.error(
        `cascadeEmailToLinkedUser: cannot rename linked User ${linkedUser._id} to "${normalizedNext}" — already in use by another main account. The CrmUser and User records will remain unlinked until this is resolved manually.`,
      );
      return;
    }

    await User.findByIdAndUpdate(linkedUser._id, { $set: { email: normalizedNext } });
    invalidateUserCache((linkedUser._id as any).toString());
  } catch (error) {
    console.error('cascadeEmailToLinkedUser failed (best-effort, primary write already succeeded):', error);
  }
}
