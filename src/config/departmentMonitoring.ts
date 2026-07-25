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

/**
 * Gates the entire Shift Alerts location-monitoring feature for this
 * department: no-location-at-shift-start, turned-off-mid-shift auto-clockout,
 * no-location-after-break, and connection-lost detection. Defaults to
 * required/true (matching how the feature already behaves for everyone) —
 * an admin explicitly toggles a department's "Require Location for
 * TimeProof" switch off to exempt it, at which point TimeProof behaves as if
 * location sharing doesn't exist: no triggers, no alerts, no auto-clockout.
 * Unlike the other checks in this file, the "no matching entry" case must
 * default to true, not false — a user with no resolvable department should
 * never silently become exempt from something on by default for everyone.
 */
export async function isLocationRequiredForTimeproof(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  const entry = await findDepartmentEntry(organizationId, department);
  return entry ? entry.locationRequiredForTimeproof : true;
}

export type LocationRequirementOverride = 'default' | 'required' | 'exempt';

/**
 * Layers a per-user exception on top of isLocationRequiredForTimeproof, for
 * the case where one specific person needs the opposite of what their
 * department is set to (e.g. required even though their department is
 * exempted, or vice versa) — set via the "Location Requirement" control on
 * the Edit User modal. 'default' (the normal case for everyone) defers
 * entirely to the department-level toggle; 'required'/'exempt' short-circuit
 * it for this one account.
 */
export async function isLocationRequiredForUser(
  organizationId: string | undefined | null,
  department: string | undefined | null,
  override?: LocationRequirementOverride | null
): Promise<boolean> {
  if (override === 'required') return true;
  if (override === 'exempt') return false;
  return isLocationRequiredForTimeproof(organizationId, department);
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

// Web Dev only, by explicit request — hidden from admins and every other
// department, no UI/toggle anywhere. Hardcoded the same way as
// MAIN_MONITOR_ONLY_DEPARTMENTS above, deliberately not a general
// admin-facing setting.
const IDLE_DETECTION_EXEMPT_DEPARTMENTS = ['WebDevTeam'];

export async function isIdleDetectionExemptDept(
  organizationId: string | undefined | null,
  department?: string | null
): Promise<boolean> {
  const entry = await findDepartmentEntry(organizationId, department);
  const key = entry?.key || department;
  return !!key && IDLE_DETECTION_EXEMPT_DEPARTMENTS.includes(key);
}
