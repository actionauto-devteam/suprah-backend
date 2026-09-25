import EmployeeLocation from '../models/EmployeeLocation.model';
import { resolveMonitoringMode } from '../config/departmentMonitoring';
import type { MonitoringMode, MonitoringModeOverride } from '../config/departmentMonitoring';
import { getLocationTuning, isDesktopActiveOverPhone } from './locationChannel.util';
import { isLocationFeatureOn } from './locationFlags.util';
import { isDeviceSwitchEnabledForUser } from './deviceSwitch.util';
import { getActiveDevice } from './monitoringDeviceState.util';

const FRESH_MOBILE_PING_MS = 10 * 60 * 1000;
const HANDOFF_SELECT = 'deviceType sharingState lastSeenAt desktopLastSeenAt desktopInputAgeSec';

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

export async function isDesktopActiveOverPhoneNow(userId: string, mode: MonitoringMode): Promise<boolean> {
  try {
    const record = await EmployeeLocation.findOne({ userId }).select(HANDOFF_SELECT).lean();
    if (!record) return false;
    return isDesktopActiveOverPhone({
      mode,
      main: record,
      desktop: record,
      nowMs: Date.now(),
      tuning: getLocationTuning(),
    });
  } catch {
    return false;
  }
}

export async function resolveScreenshotsRequired(params: {
  userId: string;
  organizationId?: string | null;
  department?: string | null;
  monitoringModeOverride?: MonitoringModeOverride | null;
  screenshotExempt?: boolean | null;
  deviceSwitchOverride?: unknown;
}): Promise<boolean> {
  if (params.screenshotExempt) return false;
  const mode = await resolveMonitoringMode(params.organizationId, params.department, params.monitoringModeOverride);
  if (mode === 'off') return true;
  if (mode === 'always') return false;
  if (isDeviceSwitchEnabledForUser({ _id: params.userId, deviceSwitchOverride: params.deviceSwitchOverride })) {
    const device = await getActiveDevice(params.userId).catch(() => null);
    if (device === 'desktop') return true;
    if (device === 'mobile') return false;
  }
  if (!(await isOnMobileNow(params.userId))) return true;
  if (!isLocationFeatureOn('LOC_HANDOFF_SCREENSHOTS', params.userId)) return false;
  return isDesktopActiveOverPhoneNow(params.userId, mode);
}
