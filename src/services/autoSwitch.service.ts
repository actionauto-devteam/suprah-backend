import Place from '../models/Place.model';
import MonitoringDeviceState from '../models/MonitoringDeviceState.model';
import { getOpenShiftStart } from '../utils/monitoringDeviceState.util';
import { isStateForShift } from '../utils/deviceSwitch.util';
import {
  AUTO_SWITCH_ACCURACY_MAX_M,
  classifyAgainstWorkSites,
  decideAutoSwitchStep,
  getAutoSwitchAwayMs,
  isAutoSwitchEnabledForUser,
} from '../utils/autoSwitch.util';
import type { AutoSwitchStep, WorkSiteRef } from '../utils/autoSwitch.util';
import { switchMonitoringDevice } from './monitoringDevice.service';
import type { DeviceSwitchSubject } from './monitoringDevice.service';

const WORK_SITE_CACHE_TTL_MS = 30_000;

const workSiteCache = new Map<string, { loadedAt: number; sites: WorkSiteRef[] }>();

export const invalidateWorkSiteCache = (organizationId?: unknown): void => {
  if (organizationId === undefined || organizationId === null) {
    workSiteCache.clear();
    return;
  }
  workSiteCache.delete(String(organizationId));
};

const loadWorkSites = async (organizationId: string, nowMs: number): Promise<WorkSiteRef[]> => {
  const cached = workSiteCache.get(organizationId);
  if (cached && nowMs - cached.loadedAt < WORK_SITE_CACHE_TTL_MS) return cached.sites;
  const rows: any[] = await Place.find({ organizationId, isActive: true, isWorkSite: true })
    .select('name coords radiusM warningRadiusM')
    .lean();
  const sites: WorkSiteRef[] = rows.map((row) => ({
    name: row.name,
    coords: { lat: row.coords.lat, lng: row.coords.lng },
    radiusM: row.radiusM,
    warningRadiusM: row.warningRadiusM ?? null,
  }));
  workSiteCache.set(organizationId, { loadedAt: nowMs, sites });
  return sites;
};

export async function processMobilePingForAutoSwitch(params: {
  user: DeviceSwitchSubject;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  nowMs?: number;
}): Promise<AutoSwitchStep> {
  const { user, lat, lng, accuracyM } = params;
  const nowMs = params.nowMs ?? Date.now();

  if (!user.organizationId || !isAutoSwitchEnabledForUser(user)) return 'none';
  if (typeof accuracyM === 'number' && accuracyM > AUTO_SWITCH_ACCURACY_MAX_M) return 'none';

  const sites = await loadWorkSites(String(user.organizationId), nowMs);
  if (sites.length === 0) return 'none';

  const state: any = await MonitoringDeviceState.findById(user._id)
    .select('shiftStartedAt activeDevice awaySince awayLastPingAt awayPaused')
    .lean();
  if (!state) return 'none';

  const shiftStartedAt = await getOpenShiftStart(user._id);
  if (!shiftStartedAt || !isStateForShift(state.shiftStartedAt, shiftStartedAt)) return 'none';

  const reading = classifyAgainstWorkSites(lat, lng, sites);
  const activeDevice = state.activeDevice === 'mobile' ? 'mobile' : state.activeDevice === 'desktop' ? 'desktop' : null;
  const step = decideAutoSwitchStep({
    away: reading.away,
    activeDevice,
    awaySince: state.awaySince,
    awayLastPingAt: state.awayLastPingAt,
    paused: state.awayPaused === true,
    nowMs,
    awayMs: getAutoSwitchAwayMs(),
  });
  if (step === 'none') return step;

  const filter = { _id: user._id, shiftStartedAt };
  const now = new Date(nowMs);
  if (step === 'clear') {
    await MonitoringDeviceState.updateOne(filter, {
      $unset: { awaySince: '', awayLastPingAt: '', awaySiteName: '', awayPaused: '' },
    });
    return step;
  }
  if (step === 'start') {
    await MonitoringDeviceState.updateOne(filter, {
      $set: { awaySince: now, awayLastPingAt: now, awaySiteName: reading.siteName, awayPaused: false },
    });
    return step;
  }

  await MonitoringDeviceState.updateOne(filter, { $set: { awayLastPingAt: now, awaySiteName: reading.siteName } });
  if (step === 'switch') {
    await switchMonitoringDevice({ user, to: 'mobile', actor: 'geofence', placeName: reading.siteName });
  }
  return step;
}
