export const PAYROLL_ACCESS_ROLES = ['admin', 'manager'] as const;
export const VIEW_USERS_ALWAYS_DEPARTMENTS = ['WebDevTeam'];

type AccessUser = {
  role?: string | null;
  payrollAccess?: boolean | null;
  isSystem?: boolean | null;
  department?: string | null;
} | null;

const hasAccessRole = (user?: AccessUser): user is NonNullable<AccessUser> =>
  !!user && !!user.role && (PAYROLL_ACCESS_ROLES as readonly string[]).includes(user.role);

export function payrollAccessSwitch(user?: AccessUser): boolean {
  if (!hasAccessRole(user)) return false;
  if (user.payrollAccess === true) return true;
  if (user.payrollAccess === false) return false;
  return user.role === 'admin' && !user.isSystem;
}

export function hasPayrollAccess(user?: AccessUser): boolean {
  if (hasAccessRole(user) && !!user.department && VIEW_USERS_ALWAYS_DEPARTMENTS.includes(user.department)) return true;
  return payrollAccessSwitch(user);
}
