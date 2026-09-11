import EmployeeLocation from '../models/EmployeeLocation.model';
import { resolveMonitoringMode, MonitoringModeOverride } from '../config/departmentMonitoring';

const FRESH_MOBILE_PING_MS = 10 * 60 * 1000;

export async function isOnMobileNow(userId: string): Promise<boolean> {
  const loc = await EmployeeLocation.findOne({
    userId,
    deviceType: 'mobile',
    sharingState: 'sharing',
    lastSeenAt: { $gte: new Date(Date.now() - FRESH_MOBILE_PING_MS) },
  })
    .select('_id')
    .lean();
  return !!loc;
}

export async function resolveScreenshotsRequired(params: {
  userId: string;
  organizationId?: string | null;
  department?: string | null;
  monitoringModeOverride?: MonitoringModeOverride | null;
  screenshotExempt?: boolean | null;
}): Promise<boolean> {
  if (params.screenshotExempt) return false;
  const mode = await resolveMonitoringMode(params.organizationId, params.department, params.monitoringModeOverride);
  if (mode === 'off') return true;
  if (mode === 'always') return false;
  return !(await isOnMobileNow(params.userId));
}
