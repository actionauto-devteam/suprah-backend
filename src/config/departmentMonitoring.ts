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

const TIME_EDIT_EXEMPT_DEPARTMENTS = ['WebDevTeam'];

export function isTimeEditExempt(department?: string | null): boolean {
  return !!department && TIME_EDIT_EXEMPT_DEPARTMENTS.includes(department);
}
