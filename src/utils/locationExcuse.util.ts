import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import type { SharingState } from '../models/EmployeeLocation.model';
import { resolveMonitoringMode } from '../config/departmentMonitoring';
import { isDesktopChannelFresh, isSilenceExcused, getLocationTuning } from './locationChannel.util';
import type { LocationDeviceType } from './locationChannel.util';
import { isLocationFeatureOnForUser } from './locationFlags.util';
import { isDesktopActiveForUserId } from './monitoringDeviceState.util';

export interface LocationRecordLike {
  userId: { toString(): string };
  userModel?: string | null;
  organizationId?: { toString(): string } | null;
  department?: string | null;
  sharingState?: SharingState | null;
  deviceType?: LocationDeviceType | null;
  lastSeenAt?: Date | string | number | null;
  desktopLastSeenAt?: Date | string | number | null;
  desktopInputAgeSec?: number | null;
}

export async function isLocationSilenceExcusedForRecord(
  loc: LocationRecordLike,
  nowMs: number,
): Promise<boolean> {
  try {
    if (loc.userModel === 'CrmUser' && (await isDesktopActiveForUserId(loc.userId))) return true;
    const tuning = getLocationTuning();
    if (loc.sharingState !== 'sharing' || !isDesktopChannelFresh(loc, nowMs, tuning.desktopFreshMs)) return false;

    const isCrm = loc.userModel === 'CrmUser';
    const actorDoc: any = isCrm
      ? await CrmUser.findById(loc.userId).select('department monitoringModeOverride desktopLocationOverride').lean()
      : await User.findById(loc.userId).select('personalInfo.department monitoringModeOverride').lean();
    if (!isLocationFeatureOnForUser('LOC_DESKTOP_EXCUSE', { _id: loc.userId, desktopLocationOverride: actorDoc?.desktopLocationOverride })) return false;
    const department = (isCrm ? actorDoc?.department : actorDoc?.personalInfo?.department) ?? loc.department;
    const mode = await resolveMonitoringMode(
      loc.organizationId?.toString(),
      department,
      actorDoc?.monitoringModeOverride,
    );
    return isSilenceExcused({ mode, main: loc, desktop: loc, nowMs, tuning });
  } catch {
    return false;
  }
}
