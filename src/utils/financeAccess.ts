import { NextFunction, Request, Response } from 'express';
import User from '../models/User.model';
import { ApiError } from './ApiError';

/**
 * Finance access (2026-11-21): who can send payment requests and invoices,
 * edit, cancel and refund payments in a dealership. Admins (and Suprah super
 * admins) always can; other staff only when a dealership admin gave them
 * Finance access on the Members page. Everyone on the staff can still view
 * payments.
 */

export const FINANCE_ACCESS_MESSAGE =
  "Only your dealership's admins and staff with Finance access can send payment requests and invoices, cancel or refund payments.";

type FinanceUser = {
  role?: string | null;
  financeOrganizationIds?: unknown[] | null;
} | null | undefined;

export function hasFinanceAccess(user: FinanceUser, orgId: string | null | undefined, orgRole?: string | null): boolean {
  if (!user) return false;
  if (user.role === 'super_admin' || user.role === 'admin' || orgRole === 'admin') return true;
  if (user.role !== 'employee' || !orgId) return false;
  const ids = Array.isArray(user.financeOrganizationIds) ? user.financeOrganizationIds : [];
  return ids.some((id) => String(id) === String(orgId));
}

/** Route guard for the payment actions above. */
export function requireFinanceAccess(req: Request, _res: Response, next: NextFunction) {
  if (hasFinanceAccess(req.user as FinanceUser, req.orgId, req.orgRole)) return next();
  return next(new ApiError(403, FINANCE_ACCESS_MESSAGE));
}

/**
 * The same rule for CRM accounts (Aftermarket invoices are sent from the CRM):
 * a CRM admin always can; anyone else needs Finance access on their website
 * account with the same email in the same dealership.
 */
export async function crmUserHasFinanceAccess(crmUser: {
  role?: string | null;
  email?: string | null;
  organizationId?: unknown;
} | null | undefined): Promise<boolean> {
  if (!crmUser?.organizationId) return false;
  if (crmUser.role === 'admin') return true;
  const email = typeof crmUser.email === 'string' ? crmUser.email.trim().toLowerCase() : '';
  if (!email) return false;
  const orgId = String(crmUser.organizationId);
  const account = await User.findOne({ email, organizationId: orgId })
    .select('role financeOrganizationIds')
    .lean();
  return hasFinanceAccess(account as FinanceUser, orgId);
}
