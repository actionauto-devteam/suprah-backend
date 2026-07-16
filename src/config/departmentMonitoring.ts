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
