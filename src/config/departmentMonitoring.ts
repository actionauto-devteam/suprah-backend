// Central config for department-specific TimeProof monitoring behavior.
// A department listed here uses the mobile-only monitoring profile: no desktop
// tray app, no screenshot capture, and GPS "stationary" time (not desktop idle)
// as its idle signal. Add more department keys here if another department needs
// the same mobile-monitoring profile — do not hardcode department name checks
// elsewhere in the codebase.
const MOBILE_MONITORING_DEPARTMENTS = ['LotTechTeam'];

export function isMobileMonitoringDept(department?: string | null): boolean {
  return !!department && MOBILE_MONITORING_DEPARTMENTS.includes(department);
}

export function requiresScreenshots(department?: string | null): boolean {
  return !isMobileMonitoringDept(department);
}

export function usesGpsStationaryIdle(department?: string | null): boolean {
  return isMobileMonitoringDept(department);
}

// Departments whose TimeLog entries and screenshots admins may NOT edit/exclude,
// even for a shift that overran because the employee forgot to clock out.
const TIME_EDIT_EXEMPT_DEPARTMENTS = ['WebDevTeam'];

export function isTimeEditExempt(department?: string | null): boolean {
  return !!department && TIME_EDIT_EXEMPT_DEPARTMENTS.includes(department);
}
