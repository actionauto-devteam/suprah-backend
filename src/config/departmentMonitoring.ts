import { findDepartmentEntry } from '../services/department.service';

export async function isMobileMonitoringDept(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  const entry = await findDepartmentEntry(organizationId, department);
  return !!entry?.isMobileMonitoringDept;
}

export async function requiresScreenshots(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  return !(await isMobileMonitoringDept(organizationId, department));
}

export async function usesGpsStationaryIdle(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  return isMobileMonitoringDept(organizationId, department);
}

export async function isTimeEditExempt(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  const entry = await findDepartmentEntry(organizationId, department);
  return !!entry?.isTimeEditExempt;
}

// Web Dev only, by explicit request — devs commonly run multiple monitors for
// work unrelated to what TimeProof needs to verify, and screenshotting all of
// them captures more than intended. Hardcoded rather than a new admin-facing
// department flag (matches the existing WebDevTeam special-case in
// call.controller.ts) since this is scoped to one department on purpose, not
// meant to be a general, admin-toggleable setting.
const MAIN_MONITOR_ONLY_DEPARTMENTS = ['WebDevTeam'];

export async function isMainMonitorOnlyDept(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  const entry = await findDepartmentEntry(organizationId, department);
  const key = entry?.key || department;
  return !!key && MAIN_MONITOR_ONLY_DEPARTMENTS.includes(key);
}
