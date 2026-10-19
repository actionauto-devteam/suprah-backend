export const PAYROLL_ACCESS_ROLES = ['admin', 'manager'] as const;

export function hasPayrollAccess(
  user?: { role?: string | null; payrollAccess?: boolean | null; isSystem?: boolean | null } | null,
): boolean {
  if (!user || !user.role || !(PAYROLL_ACCESS_ROLES as readonly string[]).includes(user.role)) return false;
  if (user.payrollAccess === true) return true;
  if (user.payrollAccess === false) return false;
  return user.role === 'admin' && !user.isSystem;
}
