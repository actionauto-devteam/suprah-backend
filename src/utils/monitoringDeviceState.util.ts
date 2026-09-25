import TimeLog from '../models/TimeLog.model';
import CrmUser from '../models/CrmUser.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import MonitoringDeviceState from '../models/MonitoringDeviceState.model';
import { isDeviceSwitchEnabledForUser, isStateForShift, MOBILE_SHIFT_GUARD_MS } from './deviceSwitch.util';
import type { MonitoringDevice } from './deviceSwitch.util';

const LOOKBACK_DAYS = 2;

export async function getOpenShiftStart(userId: unknown): Promise<Date | null> {
  const lookbackStart = new Date();
  lookbackStart.setDate(lookbackStart.getDate() - LOOKBACK_DAYS);
  lookbackStart.setHours(0, 0, 0, 0);

  const logs = await TimeLog.find({ userId, timestamp: { $gte: lookbackStart } })
    .sort({ timestamp: 1 })
    .select('type timestamp')
    .lean();

  let shiftStartedAt: Date | null = null;
  for (const log of logs) {
    if (log.type === 'time-in') shiftStartedAt = new Date(log.timestamp);
    else if (log.type === 'time-out') shiftStartedAt = null;
  }
  return shiftStartedAt;
}

export async function getActiveDevice(
  userId: unknown,
  shiftStartedAt?: Date | null,
): Promise<MonitoringDevice | null> {
  const start = shiftStartedAt === undefined ? await getOpenShiftStart(userId) : shiftStartedAt;
  if (!start) return null;
  const state: any = await MonitoringDeviceState.findById(userId).select('activeDevice shiftStartedAt').lean();
  if (!state || !isStateForShift(state.shiftStartedAt, start)) return null;
  return state.activeDevice === 'mobile' ? 'mobile' : state.activeDevice === 'desktop' ? 'desktop' : null;
}

export async function isDeviceSwitchOnForUserId(userId: unknown): Promise<boolean> {
  const doc: any = await CrmUser.findById(userId).select('deviceSwitchOverride').lean();
  return isDeviceSwitchEnabledForUser({ _id: String(userId), deviceSwitchOverride: doc?.deviceSwitchOverride });
}

export async function isDesktopActiveForUserId(userId: unknown): Promise<boolean> {
  try {
    if (!(await isDeviceSwitchOnForUserId(userId))) return false;
    return (await getActiveDevice(userId)) === 'desktop';
  } catch {
    return false;
  }
}

export async function isMobileActiveWithFreshPhone(userId: unknown, nowMs: number): Promise<boolean> {
  try {
    if (!(await isDeviceSwitchOnForUserId(userId))) return false;
    if ((await getActiveDevice(userId)) !== 'mobile') return false;
    const fresh = await EmployeeLocation.findOne({
      userId,
      deviceType: 'mobile',
      lastSeenAt: { $gte: new Date(nowMs - MOBILE_SHIFT_GUARD_MS) },
    })
      .select('_id')
      .lean();
    return !!fresh;
  } catch {
    return false;
  }
}
