import TrayDevice from '../models/TrayDevice.model';
import TrayBootstrapCode from '../models/TrayBootstrapCode.model';
import CrmUser from '../models/CrmUser.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import AuditLog from '../models/AuditLog.model';
import { generateCrmToken } from '../middleware/crmAuth.middleware';
import { getShiftStatusForActor } from '../utils/shiftStatus';
import {
  BOOTSTRAP_CODE_TTL_SEC,
  MAX_ACTIVE_DEVICES_PER_USER,
  computeDeviceExpiry,
  decideConnect,
  generateBootstrapCode,
  generateDeviceId,
  generateDeviceSecret,
  getDeviceIdleMs,
  getTrayTokenTtl,
  hashSecret,
  isDeviceExpired,
  isPlausibleCode,
  isPlausibleSecret,
  isTrayDeviceAuthEnabledForUser,
  isTrayDeviceAuthKilled,
  isValidDeviceId,
  secretsMatch,
} from '../utils/trayDevice.util';
import type { CodeState, DeviceErrorCode, DeviceState } from '../utils/trayDevice.util';

export interface DeviceMeta {
  label: string;
  platform: string;
  appVersion: string;
}

export interface ConnectParams {
  deviceId?: unknown;
  deviceSecret?: unknown;
  bootstrapCode?: unknown;
  confirmSwitch?: boolean;
  preview?: boolean;
  meta: DeviceMeta;
}

export interface ConnectPreview {
  ok: true;
  preview: { websiteName: string; websiteUserId: string };
}

export interface ServiceFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

export interface ConnectSuccess {
  ok: true;
  token: string;
  user: { id: string; fullName: string };
  credentials?: { deviceId: string; deviceSecret: string };
  registered?: boolean;
  switched?: boolean;
}

export type ConnectResult = ConnectSuccess | ConnectPreview | ServiceFailure;

const HEARTBEAT_ONLINE_MS = 5 * 60 * 1000;

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): ServiceFailure => ({
  ok: false,
  status,
  code,
  message,
  ...(extra && { extra }),
});

const ERROR_RESPONSES: Record<DeviceErrorCode, { status: number; message: string }> = {
  DEVICE_REVOKED: { status: 403, message: 'This computer was disconnected. Connect it again from Suprah.' },
  DEVICE_EXPIRED: { status: 401, message: 'This computer has been inactive for too long. Connect it again from Suprah.' },
  DEVICE_UNKNOWN: { status: 401, message: 'This computer is not registered. Connect it from Suprah.' },
  NEEDS_SETUP: { status: 401, message: 'First-time setup is required. Open Suprah and press Start Shift.' },
};

const pushEvent = (type: string, meta?: Record<string, unknown>) => ({
  $push: { events: { $each: [{ type, at: new Date(), ...(meta && { meta }) }], $slice: -20 } },
});

const recordAudit = (
  action: 'TRAY_DEVICE_REGISTERED' | 'TRAY_DEVICE_REVOKED' | 'TRAY_DEVICE_REBOUND',
  device: { deviceId: string; userId: unknown; organizationId: unknown },
  reason: string,
  performedBy?: unknown,
): void => {
  try {
    Promise.resolve(
      AuditLog.create({
        entityType: 'TrayDevice',
        entityId: device.deviceId,
        action,
        changes: { userId: String(device.userId) },
        reason,
        ...(performedBy ? { performedBy } : {}),
        organizationId: String(device.organizationId),
      }),
    ).catch(() => {});
  } catch {
    return;
  }
};

const isEnabledForUserId = async (userId: unknown): Promise<boolean> => {
  if (isTrayDeviceAuthKilled()) return false;
  const doc: any = await CrmUser.findById(userId).select('trayDeviceAuthOverride').lean();
  return isTrayDeviceAuthEnabledForUser({ _id: userId as string, trayDeviceAuthOverride: doc?.trayDeviceAuthOverride });
};

const validateUser = (user: any, expectedOrganizationId?: unknown): ServiceFailure | null => {
  if (!user || !user.isActive || user.isOffboarded) {
    return fail(403, 'USER_DISABLED', 'This account is not active.');
  }
  if (!user.organizationId) {
    return fail(403, 'ORG_ACCESS_REMOVED', 'This account no longer has organization access.');
  }
  if (expectedOrganizationId && String(expectedOrganizationId) !== String(user.organizationId)) {
    return fail(403, 'ORG_ACCESS_REMOVED', 'This account no longer has access to this organization.');
  }
  return null;
};

const mintToken = (user: any): string => generateCrmToken(String(user._id), getTrayTokenTtl());

const issuedSession = (user: any, extra: Partial<ConnectSuccess> = {}): ConnectSuccess => ({
  ok: true,
  token: mintToken(user),
  user: { id: String(user._id), fullName: user.fullName ?? '' },
  ...extra,
});

const consumeCode = async (codeHash: string): Promise<boolean> => {
  const consumed = await TrayBootstrapCode.findOneAndUpdate(
    { codeHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  return !!consumed;
};

const createDevice = async (
  user: any,
  meta: DeviceMeta,
): Promise<{ deviceId: string; deviceSecret: string }> => {
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const active: any[] = await TrayDevice.find({ userId: user._id, revokedAt: null, expiresAt: { $gt: now } })
    .sort({ lastSeenAt: 1 })
    .select('_id deviceId userId organizationId')
    .lean();
  const excess = active.length - MAX_ACTIVE_DEVICES_PER_USER + 1;
  if (excess > 0) {
    for (const stale of active.slice(0, excess)) {
      await TrayDevice.updateOne(
        { _id: stale._id },
        { $set: { revokedAt: now, revokedReason: 'device_limit' }, ...pushEvent('revoked', { reason: 'device_limit' }) },
      );
      recordAudit('TRAY_DEVICE_REVOKED', stale, 'device_limit');
    }
  }
  const deviceId = generateDeviceId();
  const deviceSecret = generateDeviceSecret();
  await TrayDevice.create({
    deviceId,
    secretHash: hashSecret(deviceSecret),
    userId: user._id,
    organizationId: user.organizationId,
    label: meta.label,
    platform: meta.platform,
    appVersion: meta.appVersion,
    lastSeenAt: now,
    expiresAt: computeDeviceExpiry(nowMs, getDeviceIdleMs()),
    credentialVersion: 1,
    events: [{ type: 'registered', at: now, meta: { platform: meta.platform } }],
  });
  recordAudit('TRAY_DEVICE_REGISTERED', { deviceId, userId: user._id, organizationId: user.organizationId }, 'registered');
  return { deviceId, deviceSecret };
};

export const recordTrayDeviceAuthOverrideChange = (
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
        changes: { trayDeviceAuthOverride: { from, to } },
        reason: 'tray_device_auth_override_changed',
        ...(performedBy ? { performedBy } : {}),
        ...(target.organizationId ? { organizationId: String(target.organizationId) } : {}),
      }),
    ).catch(() => {});
  } catch {
    return;
  }
};

export async function issueBootstrapCode(user: {
  _id: unknown;
  organizationId: unknown;
}): Promise<{ code: string; expiresInSec: number }> {
  const code = generateBootstrapCode();
  await TrayBootstrapCode.create({
    codeHash: hashSecret(code),
    userId: user._id,
    organizationId: user.organizationId,
    expiresAt: new Date(Date.now() + BOOTSTRAP_CODE_TTL_SEC * 1000),
  });
  return { code, expiresInSec: BOOTSTRAP_CODE_TTL_SEC };
}

export async function registerDeviceFromSession(
  user: any,
  meta: DeviceMeta,
): Promise<{ deviceId: string; deviceSecret: string }> {
  return createDevice(user, meta);
}

export async function getTrayDeviceStatus(userId: unknown): Promise<{
  registered: boolean;
  online: boolean;
  devices: Array<{ deviceId: string; label: string; platform: string; appVersion: string; lastSeenAt: Date; createdAt: Date }>;
}> {
  const now = new Date();
  const [devices, heartbeat] = await Promise.all([
    TrayDevice.find({ userId, revokedAt: null, expiresAt: { $gt: now } }).sort({ lastSeenAt: -1 }).lean(),
    AgentHeartbeat.findOne({ userId }).select('lastSeenAt').lean(),
  ]);
  const online = !!heartbeat && now.getTime() - new Date((heartbeat as any).lastSeenAt).getTime() < HEARTBEAT_ONLINE_MS;
  return {
    registered: devices.length > 0,
    online,
    devices: devices.map((device: any) => ({
      deviceId: device.deviceId,
      label: device.label,
      platform: device.platform,
      appVersion: device.appVersion,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.createdAt,
    })),
  };
}

export async function connectDevice(params: ConnectParams): Promise<ConnectResult> {
  if (isTrayDeviceAuthKilled()) {
    return fail(503, 'TRAY_DEVICE_AUTH_DISABLED', 'Device sign-in is temporarily unavailable.');
  }
  const nowMs = Date.now();
  const now = new Date(nowMs);

  let device: any = null;
  let deviceState: DeviceState = 'none';
  if (params.deviceId !== undefined || params.deviceSecret !== undefined) {
    if (!isValidDeviceId(params.deviceId) || !isPlausibleSecret(params.deviceSecret)) {
      deviceState = 'unknown';
    } else {
      const found: any = await TrayDevice.findOne({ deviceId: params.deviceId }).lean();
      if (!found || !secretsMatch(params.deviceSecret, found.secretHash)) deviceState = 'unknown';
      else if (found.revokedAt) deviceState = 'revoked';
      else if (isDeviceExpired(found.expiresAt, nowMs)) deviceState = 'expired';
      else {
        deviceState = 'valid';
        device = found;
      }
    }
  }

  let codeDoc: any = null;
  let codeState: CodeState = 'none';
  let codeHash = '';
  if (params.bootstrapCode !== undefined) {
    if (!isPlausibleCode(params.bootstrapCode)) codeState = 'invalid';
    else {
      codeHash = hashSecret(params.bootstrapCode);
      codeDoc = await TrayBootstrapCode.findOne({ codeHash, usedAt: null, expiresAt: { $gt: now } }).lean();
      codeState = codeDoc ? 'valid' : 'invalid';
    }
  }

  const codeUserMatchesDevice = !!device && !!codeDoc && String(codeDoc.userId) === String(device.userId);
  const deviceUserHasOpenShift =
    !!device && !!codeDoc && !codeUserMatchesDevice
      ? (await getShiftStatusForActor(device.userId)).isOnShift
      : false;

  const decision = decideConnect({
    deviceState,
    codeState,
    codeUserMatchesDevice,
    confirmSwitch: params.confirmSwitch === true,
    deviceUserHasOpenShift,
  });

  if (decision.action === 'ERROR') {
    const response = ERROR_RESPONSES[decision.code];
    return fail(response.status, decision.code, response.message);
  }

  const flagUserId = decision.action === 'REGISTER' || decision.action === 'REBIND' ? codeDoc?.userId : device?.userId;
  if (
    (decision.action === 'SESSION' || decision.action === 'SESSION_CONSUME_CODE' || decision.action === 'REGISTER' || decision.action === 'REBIND')
    && !(await isEnabledForUserId(flagUserId))
  ) {
    return fail(403, 'TRAY_DEVICE_AUTH_OFF', 'Device sign-in is not enabled for this account.');
  }

  if (decision.action === 'SESSION' || decision.action === 'SESSION_CONSUME_CODE') {
    const user: any = await CrmUser.findById(device.userId).select('fullName isActive isOffboarded organizationId').lean();
    const invalid = validateUser(user, device.organizationId);
    if (invalid) return invalid;
    if (decision.action === 'SESSION_CONSUME_CODE') await consumeCode(codeHash);
    await TrayDevice.updateOne(
      { _id: device._id },
      {
        $set: {
          lastSeenAt: now,
          expiresAt: computeDeviceExpiry(nowMs, getDeviceIdleMs()),
          ...(params.meta.appVersion && { appVersion: params.meta.appVersion }),
          ...(params.meta.label && { label: params.meta.label }),
          ...(params.meta.platform && { platform: params.meta.platform }),
        },
      },
    );
    return issuedSession(user);
  }

  if (decision.action === 'MISMATCH') {
    const [registered, website]: any[] = await Promise.all([
      CrmUser.findById(device.userId).select('fullName').lean(),
      CrmUser.findById(codeDoc.userId).select('fullName').lean(),
    ]);
    await TrayDevice.updateOne({ _id: device._id }, pushEvent('mismatch', { websiteUserId: String(codeDoc.userId) }));
    return fail(409, 'ACCOUNT_MISMATCH', 'This computer is set up for a different account.', {
      registeredName: registered?.fullName ?? '',
      websiteName: website?.fullName ?? '',
    });
  }

  if (decision.action === 'SHIFT_IN_PROGRESS') {
    const registered: any = await CrmUser.findById(device.userId).select('fullName').lean();
    return fail(409, 'SHIFT_IN_PROGRESS', 'The account on this computer has a shift in progress.', {
      registeredName: registered?.fullName ?? '',
    });
  }

  const codeUser: any = await CrmUser.findById(codeDoc.userId).select('fullName isActive isOffboarded organizationId').lean();
  const invalidCodeUser = validateUser(codeUser, codeDoc.organizationId);
  if (invalidCodeUser) return invalidCodeUser;
  if (decision.action === 'REGISTER' && params.preview === true) {
    return { ok: true, preview: { websiteName: codeUser.fullName ?? '', websiteUserId: String(codeUser._id) } };
  }
  if (!(await consumeCode(codeHash))) {
    return fail(401, 'CODE_INVALID', 'That connection request expired. Try again from Suprah.');
  }

  if (decision.action === 'REGISTER') {
    const credentials = await createDevice(codeUser, params.meta);
    return issuedSession(codeUser, { credentials, registered: true });
  }

  const deviceSecret = generateDeviceSecret();
  await TrayDevice.updateOne(
    { _id: device._id },
    {
      $set: {
        userId: codeUser._id,
        organizationId: codeUser.organizationId,
        secretHash: hashSecret(deviceSecret),
        lastSeenAt: now,
        expiresAt: computeDeviceExpiry(nowMs, getDeviceIdleMs()),
        revokedAt: null,
        revokedReason: null,
        ...(params.meta.appVersion && { appVersion: params.meta.appVersion }),
        ...(params.meta.label && { label: params.meta.label }),
        ...(params.meta.platform && { platform: params.meta.platform }),
      },
      $inc: { credentialVersion: 1 },
      ...pushEvent('rebound', { fromUserId: String(device.userId), toUserId: String(codeUser._id) }),
    },
  );
  recordAudit(
    'TRAY_DEVICE_REBOUND',
    { deviceId: device.deviceId, userId: codeUser._id, organizationId: codeUser.organizationId },
    `rebound from ${String(device.userId)}`,
  );
  return issuedSession(codeUser, { credentials: { deviceId: device.deviceId, deviceSecret }, switched: true });
}

export async function disconnectDevice(deviceId: unknown, deviceSecret: unknown): Promise<'ok' | 'unknown'> {
  if (!isValidDeviceId(deviceId) || !isPlausibleSecret(deviceSecret)) return 'unknown';
  const device: any = await TrayDevice.findOne({ deviceId }).lean();
  if (!device || !secretsMatch(deviceSecret, device.secretHash)) return 'unknown';
  if (!device.revokedAt) {
    await TrayDevice.updateOne(
      { _id: device._id },
      { $set: { revokedAt: new Date(), revokedReason: 'disconnected_by_device' }, ...pushEvent('disconnected') },
    );
    recordAudit('TRAY_DEVICE_REVOKED', device, 'disconnected_by_device');
  }
  return 'ok';
}

export async function revokeDeviceById(
  deviceId: string,
  actor: { id: unknown; role?: string; organizationId?: unknown },
): Promise<'ok' | 'not_found' | 'forbidden'> {
  if (!isValidDeviceId(deviceId)) return 'not_found';
  const device: any = await TrayDevice.findOne({ deviceId }).lean();
  if (!device) return 'not_found';
  const isOwner = String(device.userId) === String(actor.id);
  const isOrgAdmin = actor.role === 'admin' && String(device.organizationId) === String(actor.organizationId);
  if (!isOwner && !isOrgAdmin) return 'forbidden';
  if (!device.revokedAt) {
    const reason = isOwner ? 'revoked_by_owner' : 'revoked_by_admin';
    await TrayDevice.updateOne(
      { _id: device._id },
      { $set: { revokedAt: new Date(), revokedReason: reason }, ...pushEvent('revoked', { reason }) },
    );
    recordAudit('TRAY_DEVICE_REVOKED', device, reason, actor.id);
  }
  return 'ok';
}

export async function revokeUserTrayDevices(userId: unknown, reason: string): Promise<number> {
  const result: any = await TrayDevice.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason }, ...pushEvent('revoked', { reason }) },
  );
  return typeof result?.modifiedCount === 'number' ? result.modifiedCount : 0;
}

export async function revokeTrayDevicesForEmail(
  email: string,
  organizationId: unknown,
  reason: string,
): Promise<number> {
  if (!email) return 0;
  const crmUser: any = await CrmUser.findOne({ email: email.toLowerCase(), organizationId }).select('_id').lean();
  return crmUser ? revokeUserTrayDevices(crmUser._id, reason) : 0;
}
