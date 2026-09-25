import MonitoringDeviceState from '../models/MonitoringDeviceState.model';
import EmployeeLocation from '../models/EmployeeLocation.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import AuditLog from '../models/AuditLog.model';
import { resolveMonitoringMode } from '../config/departmentMonitoring';
import { emitToUser, emitToShiftBoard } from '../utils/socketEmitter';
import {
  MOBILE_PING_FRESH_MS,
  TRAY_HEARTBEAT_FRESH_MS,
  decideSwitch,
  deviceFromHint,
  isDeviceSwitchEnabledForUser,
  isMonitoringDevice,
  isStateForShift,
} from '../utils/deviceSwitch.util';
import type { MonitoringDevice, SwitchActor } from '../utils/deviceSwitch.util';
import { getActiveDevice, getOpenShiftStart } from '../utils/monitoringDeviceState.util';

export interface DeviceSwitchSubject {
  _id: { toString(): string };
  organizationId?: { toString(): string } | null;
  department?: string | null;
  monitoringModeOverride?: 'default' | 'off' | 'always' | 'switching' | null;
  deviceSwitchOverride?: unknown;
}

export type SwitchResult =
  | { ok: true; activeDevice: MonitoringDevice; switchedAt: Date; unchanged: boolean }
  | { ok: false; status: number; code: string; message: string };

const resolveMode = (user: DeviceSwitchSubject) =>
  resolveMonitoringMode(user.organizationId?.toString(), user.department, user.monitoringModeOverride);

const announce = (userId: string, payload: { activeDevice: MonitoringDevice; switchedAt: Date; by: string }) => {
  try {
    emitToUser(userId, 'monitoring-device', { userId, ...payload });
    emitToShiftBoard('monitoring-device', { userId, ...payload });
  } catch {
    return;
  }
};

const audit = (
  user: DeviceSwitchSubject,
  from: MonitoringDevice | null,
  to: MonitoringDevice,
  actor: SwitchActor,
  actorId: unknown,
) => {
  try {
    Promise.resolve(
      AuditLog.create({
        entityType: 'TimeLog',
        entityId: user._id.toString(),
        action: 'UPDATE',
        changes: { activeDevice: { from, to } },
        reason: actor === 'admin' ? 'monitoring_device_switched_by_admin' : 'monitoring_device_switched',
        ...(actorId ? { performedBy: actorId } : {}),
        ...(user.organizationId ? { organizationId: user.organizationId.toString() } : {}),
      }),
    ).catch(() => {});
  } catch {
    return;
  }
};

export async function initShiftDevice(
  user: DeviceSwitchSubject,
  shiftStartedAt: Date,
  deviceHint: unknown,
): Promise<void> {
  if (!user.organizationId || !isDeviceSwitchEnabledForUser(user)) return;
  if ((await resolveMode(user)) !== 'switching') return;

  const device = deviceFromHint(deviceHint);
  const at = new Date();
  await MonitoringDeviceState.updateOne(
    { _id: user._id },
    {
      $set: {
        organizationId: user.organizationId,
        shiftStartedAt,
        activeDevice: device,
        switchedAt: at,
        history: [{ from: null, to: device, at, by: 'shift-start' }],
      },
    },
    { upsert: true },
  );
  announce(user._id.toString(), { activeDevice: device, switchedAt: at, by: 'shift-start' });
}

export async function getDeviceSwitchView(
  user: DeviceSwitchSubject,
): Promise<{ enabled: boolean; activeDevice: MonitoringDevice | null }> {
  if (!isDeviceSwitchEnabledForUser(user)) return { enabled: false, activeDevice: null };
  if ((await resolveMode(user)) !== 'switching') return { enabled: false, activeDevice: null };
  return { enabled: true, activeDevice: await getActiveDevice(user._id) };
}

export async function switchMonitoringDevice(params: {
  user: DeviceSwitchSubject;
  to: unknown;
  actor: SwitchActor;
  actorId?: unknown;
}): Promise<SwitchResult> {
  const { user, actor, actorId } = params;
  if (!isMonitoringDevice(params.to)) {
    return { ok: false, status: 400, code: 'BAD_DEVICE', message: 'Choose either desktop or mobile.' };
  }
  const to = params.to;

  if (!isDeviceSwitchEnabledForUser(user)) {
    return { ok: false, status: 403, code: 'DEVICE_SWITCH_OFF', message: 'Device switching is not turned on for this account.' };
  }

  const nowMs = Date.now();
  const [mode, shiftStartedAt] = await Promise.all([resolveMode(user), getOpenShiftStart(user._id)]);
  const state: any = await MonitoringDeviceState.findById(user._id).select('activeDevice shiftStartedAt switchedAt history').lean();
  const stateValid = !!state && !!shiftStartedAt && isStateForShift(state.shiftStartedAt, shiftStartedAt);
  const current: MonitoringDevice | null = stateValid && isMonitoringDevice(state.activeDevice) ? state.activeDevice : null;

  const lastEntryBy = stateValid && Array.isArray(state.history) && state.history.length > 0
    ? state.history[state.history.length - 1]?.by
    : null;

  let mobileFresh = false;
  let trayFresh = false;
  if (actor === 'user') {
    if (to === 'mobile') {
      const ping = await EmployeeLocation.findOne({
        userId: user._id,
        deviceType: 'mobile',
        sharingState: 'sharing',
        lastSeenAt: { $gte: new Date(nowMs - MOBILE_PING_FRESH_MS) },
      })
        .select('_id')
        .lean();
      mobileFresh = !!ping;
    } else {
      const beat = await AgentHeartbeat.findOne({
        userId: user._id,
        lastSeenAt: { $gte: new Date(nowMs - TRAY_HEARTBEAT_FRESH_MS) },
      })
        .select('_id')
        .lean();
      trayFresh = !!beat;
    }
  }

  const decision = decideSwitch({
    to,
    current,
    isOnShift: !!shiftStartedAt,
    mode,
    actor,
    mobileFresh,
    trayFresh,
    lastSwitchAt: stateValid && lastEntryBy !== 'shift-start' ? state.switchedAt : null,
    nowMs,
  });
  if (!decision.ok) return decision;
  if (decision.unchanged) {
    return { ok: true, activeDevice: to, switchedAt: new Date(state.switchedAt), unchanged: true };
  }

  const at = new Date(nowMs);
  const entry = { from: current, to, at, by: actor, actorId: actorId ?? null };
  const base = {
    organizationId: user.organizationId,
    shiftStartedAt: shiftStartedAt!,
    activeDevice: to,
    switchedAt: at,
  };
  if (stateValid) {
    await MonitoringDeviceState.updateOne(
      { _id: user._id },
      { $set: base, $push: { history: { $each: [entry], $slice: -20 } } },
    );
  } else {
    await MonitoringDeviceState.updateOne(
      { _id: user._id },
      { $set: { ...base, history: [entry] } },
      { upsert: true },
    );
  }

  EmployeeLocation.updateOne(
    { userId: user._id },
    { locationIssueDetectedAt: null, locationWarningStage: 0, connectionLostNotifiedAt: null },
  ).catch(() => {});
  audit(user, current, to, actor, actorId);
  announce(user._id.toString(), { activeDevice: to, switchedAt: at, by: actor });

  return { ok: true, activeDevice: to, switchedAt: at, unchanged: false };
}

export const recordDeviceSwitchOverrideChange = (
  target: { _id: unknown; organizationId?: unknown },
  from: string,
  to: string,
  performedBy: unknown,
): void => {
  try {
    Promise.resolve(
      AuditLog.create({
        entityType: 'User',
        entityId: String(target._id),
        action: 'UPDATE',
        changes: { deviceSwitchOverride: { from, to } },
        reason: 'device_switch_override_changed',
        ...(performedBy ? { performedBy } : {}),
        ...(target.organizationId ? { organizationId: String(target.organizationId) } : {}),
      }),
    ).catch(() => {});
  } catch {
    return;
  }
};

export const clearShiftDevice = (userId: unknown): void => {
  try {
    Promise.resolve(MonitoringDeviceState.deleteOne({ _id: userId })).catch(() => {});
  } catch {
    return;
  }
};

export const recordDesktopLocationOverrideChange = (
  target: { _id: unknown; organizationId?: unknown },
  from: string,
  to: string,
  performedBy: unknown,
): void => {
  try {
    Promise.resolve(
      AuditLog.create({
        entityType: 'User',
        entityId: String(target._id),
        action: 'UPDATE',
        changes: { desktopLocationOverride: { from, to } },
        reason: 'desktop_location_override_changed',
        ...(performedBy ? { performedBy } : {}),
        ...(target.organizationId ? { organizationId: String(target.organizationId) } : {}),
      }),
    ).catch(() => {});
  } catch {
    return;
  }
};
