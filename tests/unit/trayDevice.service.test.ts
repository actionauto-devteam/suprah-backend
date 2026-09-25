const mockDeviceFindOne = jest.fn();
const mockDeviceFind = jest.fn();
const mockDeviceCreate = jest.fn();
const mockDeviceUpdateOne = jest.fn();
const mockDeviceUpdateMany = jest.fn();
const mockCodeFindOne = jest.fn();
const mockCodeFindOneAndUpdate = jest.fn();
const mockCodeCreate = jest.fn();
const mockCrmFindById = jest.fn();
const mockCrmFindOne = jest.fn();
const mockHeartbeatFindOne = jest.fn();
const mockAuditCreate = jest.fn();
const mockGenerateToken = jest.fn();
const mockShiftStatus = jest.fn();

jest.mock('../../src/models/TrayDevice.model', () => ({
  __esModule: true,
  default: {
    findOne: mockDeviceFindOne,
    find: mockDeviceFind,
    create: mockDeviceCreate,
    updateOne: mockDeviceUpdateOne,
    updateMany: mockDeviceUpdateMany,
  },
}));
jest.mock('../../src/models/TrayBootstrapCode.model', () => ({
  __esModule: true,
  default: { findOne: mockCodeFindOne, findOneAndUpdate: mockCodeFindOneAndUpdate, create: mockCodeCreate },
}));
jest.mock('../../src/models/CrmUser.model', () => ({
  __esModule: true,
  default: { findById: mockCrmFindById, findOne: mockCrmFindOne },
}));
jest.mock('../../src/models/AgentHeartbeat.model', () => ({ __esModule: true, default: { findOne: mockHeartbeatFindOne } }));
jest.mock('../../src/models/AuditLog.model', () => ({ __esModule: true, default: { create: mockAuditCreate } }));
jest.mock('../../src/middleware/crmAuth.middleware', () => ({ generateCrmToken: mockGenerateToken }));
jest.mock('../../src/utils/shiftStatus', () => ({ getShiftStatusForActor: mockShiftStatus }));

import {
  connectDevice,
  disconnectDevice,
  getTrayDeviceStatus,
  issueBootstrapCode,
  recordTrayDeviceAuthOverrideChange,
  registerDeviceFromSession,
  revokeDeviceById,
  revokeTrayDevicesForEmail,
  revokeUserTrayDevices,
} from '../../src/services/trayDevice.service';
import { generateBootstrapCode, generateDeviceId, generateDeviceSecret, hashSecret } from '../../src/utils/trayDevice.util';

const savedEnv = { ...process.env };
const meta = { label: 'DESKTOP-ABC', platform: 'win32', appVersion: '1.5.5' };
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const chain = (value: unknown) => {
  const lean = jest.fn().mockResolvedValue(value);
  const selected = { lean };
  return { lean, select: jest.fn(() => selected), sort: jest.fn(() => ({ select: jest.fn(() => selected), lean })) };
};

const userA = { _id: 'userA', fullName: 'Ana Reyes', isActive: true, isOffboarded: false, organizationId: 'org1' };
const userB = { _id: 'userB', fullName: 'Ben Cruz', isActive: true, isOffboarded: false, organizationId: 'org1' };

const makeDevice = (overrides: Record<string, unknown> = {}) => {
  const deviceId = generateDeviceId();
  const secret = generateDeviceSecret();
  return {
    secret,
    doc: {
      _id: 'dev1',
      deviceId,
      secretHash: hashSecret(secret),
      userId: 'userA',
      organizationId: 'org1',
      label: 'old',
      platform: 'win32',
      appVersion: '1.5.4',
      lastSeenAt: new Date(),
      expiresAt: inDays(10),
      revokedAt: null,
      credentialVersion: 1,
      ...overrides,
    },
  };
};

const usersById: Record<string, unknown> = { userA, userB };

describe('trayDevice.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv, TRAY_DEVICE_AUTH: 'all' };
    delete process.env.TRAY_DEVICE_AUTH_DISABLED;
    delete process.env.TRAY_TOKEN_TTL;
    mockGenerateToken.mockImplementation((id: string, ttl: string) => `token:${id}:${ttl}`);
    mockShiftStatus.mockResolvedValue({ isOnShift: false, isOnBreak: false });
    mockCrmFindById.mockImplementation((id: string) => chain(usersById[id] ?? null));
    mockDeviceUpdateOne.mockResolvedValue({});
    mockDeviceUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockDeviceCreate.mockResolvedValue({});
    mockDeviceFind.mockReturnValue(chain([]));
    mockCodeCreate.mockResolvedValue({});
    mockCodeFindOneAndUpdate.mockResolvedValue({ _id: 'code1' });
    mockAuditCreate.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  const setDevice = (doc: unknown) => mockDeviceFindOne.mockReturnValue(chain(doc));
  const setCode = (code: string, doc: unknown) => mockCodeFindOne.mockImplementation((filter: any) =>
    chain(filter.codeHash === hashSecret(code) ? doc : null));

  describe('the per-user override decides, the environment is only the default', () => {
    it('a user set to on can sign in with the environment switch completely off', async () => {
      delete process.env.TRAY_DEVICE_AUTH;
      usersById.userA = { ...userA, trayDeviceAuthOverride: 'on' };
      try {
        const { secret, doc } = makeDevice();
        setDevice(doc);
        const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
        expect(result).toMatchObject({ ok: true, user: { id: 'userA' } });
      } finally {
        usersById.userA = userA;
      }
    });

    it('a user set to on can register from a code with the environment switch off', async () => {
      delete process.env.TRAY_DEVICE_AUTH;
      usersById.userA = { ...userA, trayDeviceAuthOverride: 'on' };
      try {
        const code = generateBootstrapCode();
        setDevice(null);
        setCode(code, { userId: 'userA', organizationId: 'org1' });
        const result = await connectDevice({ bootstrapCode: code, meta });
        expect(result).toMatchObject({ ok: true, registered: true });
      } finally {
        usersById.userA = userA;
      }
    });

    it('a user set to off is refused even when the environment says all', async () => {
      process.env.TRAY_DEVICE_AUTH = 'all';
      usersById.userA = { ...userA, trayDeviceAuthOverride: 'off' };
      try {
        const { secret, doc } = makeDevice();
        setDevice(doc);
        const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
        expect(result).toMatchObject({ ok: false, status: 403, code: 'TRAY_DEVICE_AUTH_OFF' });
        expect(mockDeviceUpdateOne).not.toHaveBeenCalled();
      } finally {
        usersById.userA = userA;
      }
    });

    it('a user left on default with the environment off is refused, as before', async () => {
      delete process.env.TRAY_DEVICE_AUTH;
      const { secret, doc } = makeDevice();
      setDevice(doc);
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
      expect(result).toMatchObject({ ok: false, code: 'TRAY_DEVICE_AUTH_OFF' });
    });

    it('the kill switch still wins over a user set to on', async () => {
      process.env.TRAY_DEVICE_AUTH_DISABLED = 'true';
      usersById.userA = { ...userA, trayDeviceAuthOverride: 'on' };
      try {
        const { secret, doc } = makeDevice();
        setDevice(doc);
        const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
        expect(result).toMatchObject({ ok: false, code: 'TRAY_DEVICE_AUTH_DISABLED' });
      } finally {
        usersById.userA = userA;
      }
    });

    it('records who changed the override without ever throwing', () => {
      recordTrayDeviceAuthOverrideChange({ _id: 'userB', organizationId: 'org1' }, 'default', 'on', 'admin1');
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'User',
          entityId: 'userB',
          action: 'UPDATE',
          changes: { trayDeviceAuthOverride: { from: 'default', to: 'on' } },
          reason: 'tray_device_auth_override_changed',
          performedBy: 'admin1',
          organizationId: 'org1',
        }),
      );
      mockAuditCreate.mockImplementation(() => { throw new Error('db down'); });
      expect(() => recordTrayDeviceAuthOverrideChange({ _id: 'userB' }, 'on', 'off', undefined)).not.toThrow();
    });
  });

  describe('connectDevice with a registered device', () => {
    it('issues a 12 hour session and slides the idle expiry without touching a code', async () => {
      const { secret, doc } = makeDevice();
      setDevice(doc);
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
      expect(result).toMatchObject({ ok: true, token: 'token:userA:12h', user: { id: 'userA', fullName: 'Ana Reyes' } });
      expect((result as any).credentials).toBeUndefined();
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
      const [, update] = mockDeviceUpdateOne.mock.calls[0];
      expect(update.$set.appVersion).toBe('1.5.5');
      expect(update.$set.label).toBe('DESKTOP-ABC');
      expect(update.$set.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(mockCrmFindById).toHaveBeenCalledWith('userA');
    });

    it('honors TRAY_TOKEN_TTL', async () => {
      process.env.TRAY_TOKEN_TTL = '6h';
      const { secret, doc } = makeDevice();
      setDevice(doc);
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
      expect((result as any).token).toBe('token:userA:6h');
    });

    it('does nothing while the flag is off for the user and never mints a token', async () => {
      process.env.TRAY_DEVICE_AUTH = 'someone-else';
      const { secret, doc } = makeDevice();
      setDevice(doc);
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta });
      expect(result).toMatchObject({ ok: false, status: 403, code: 'TRAY_DEVICE_AUTH_OFF' });
      expect(mockGenerateToken).not.toHaveBeenCalled();
      expect(mockDeviceUpdateOne).not.toHaveBeenCalled();
    });

    it('is switched off entirely by the kill switch', async () => {
      process.env.TRAY_DEVICE_AUTH_DISABLED = 'true';
      const result = await connectDevice({ meta });
      expect(result).toMatchObject({ ok: false, status: 503, code: 'TRAY_DEVICE_AUTH_DISABLED' });
      expect(mockDeviceFindOne).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret, an unknown id and malformed credentials with the same code', async () => {
      const { doc } = makeDevice();
      setDevice(doc);
      const wrongSecret = await connectDevice({ deviceId: doc.deviceId, deviceSecret: generateDeviceSecret(), meta });
      expect(wrongSecret).toMatchObject({ ok: false, status: 401, code: 'DEVICE_UNKNOWN' });
      setDevice(null);
      const unknownId = await connectDevice({ deviceId: generateDeviceId(), deviceSecret: generateDeviceSecret(), meta });
      expect(unknownId).toMatchObject({ ok: false, status: 401, code: 'DEVICE_UNKNOWN' });
      const malformed = await connectDevice({ deviceId: 'nope', deviceSecret: 'short', meta });
      expect(malformed).toMatchObject({ ok: false, status: 401, code: 'DEVICE_UNKNOWN' });
      expect(mockGenerateToken).not.toHaveBeenCalled();
    });

    it('reports a revoked device and an expired device precisely', async () => {
      const revoked = makeDevice({ revokedAt: new Date() });
      setDevice(revoked.doc);
      expect(await connectDevice({ deviceId: revoked.doc.deviceId, deviceSecret: revoked.secret, meta }))
        .toMatchObject({ ok: false, status: 403, code: 'DEVICE_REVOKED' });
      const expired = makeDevice({ expiresAt: new Date(Date.now() - 1000) });
      setDevice(expired.doc);
      expect(await connectDevice({ deviceId: expired.doc.deviceId, deviceSecret: expired.secret, meta }))
        .toMatchObject({ ok: false, status: 401, code: 'DEVICE_EXPIRED' });
    });

    it('refuses to mint for a disabled, offboarded or missing user', async () => {
      const { secret, doc } = makeDevice();
      setDevice(doc);
      usersById.userA = { ...userA, isActive: false };
      expect(await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta })).toMatchObject({ code: 'USER_DISABLED' });
      usersById.userA = { ...userA, isOffboarded: true };
      expect(await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta })).toMatchObject({ code: 'USER_DISABLED' });
      usersById.userA = null;
      expect(await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta })).toMatchObject({ code: 'USER_DISABLED' });
      usersById.userA = userA;
      expect(mockGenerateToken).not.toHaveBeenCalled();
    });

    it('refuses to mint when the organization changed', async () => {
      const { secret, doc } = makeDevice({ organizationId: 'orgOld' });
      setDevice(doc);
      expect(await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, meta }))
        .toMatchObject({ ok: false, status: 403, code: 'ORG_ACCESS_REMOVED' });
      usersById.userA = { ...userA, organizationId: undefined };
      const { secret: secret2, doc: doc2 } = makeDevice();
      setDevice(doc2);
      expect(await connectDevice({ deviceId: doc2.deviceId, deviceSecret: secret2, meta })).toMatchObject({ code: 'ORG_ACCESS_REMOVED' });
      usersById.userA = userA;
    });

    it('ignores an expired or unknown code when the device is valid', async () => {
      const { secret, doc } = makeDevice();
      setDevice(doc);
      mockCodeFindOne.mockReturnValue(chain(null));
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: generateBootstrapCode(), meta });
      expect(result).toMatchObject({ ok: true, token: 'token:userA:12h' });
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('consumes a code that belongs to the same user', async () => {
      const { secret, doc } = makeDevice();
      const code = generateBootstrapCode();
      setDevice(doc);
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, meta });
      expect(result).toMatchObject({ ok: true, token: 'token:userA:12h' });
      expect(mockCodeFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockShiftStatus).not.toHaveBeenCalled();
    });
  });

  describe('account switching', () => {
    const arrange = () => {
      const { secret, doc } = makeDevice();
      const code = generateBootstrapCode();
      setDevice(doc);
      setCode(code, { userId: 'userB', organizationId: 'org1' });
      return { secret, doc, code };
    };

    it('asks for confirmation on a different user and consumes nothing', async () => {
      const { secret, doc, code } = arrange();
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, meta });
      expect(result).toMatchObject({
        ok: false,
        status: 409,
        code: 'ACCOUNT_MISMATCH',
        extra: { registeredName: 'Ana Reyes', websiteName: 'Ben Cruz' },
      });
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockGenerateToken).not.toHaveBeenCalled();
      const [, update] = mockDeviceUpdateOne.mock.calls[0];
      expect(update.$push.events.$each[0].type).toBe('mismatch');
    });

    it('never switches while the registered user has an open shift, even when confirmed', async () => {
      const { secret, doc, code } = arrange();
      mockShiftStatus.mockResolvedValue({ isOnShift: true, isOnBreak: false });
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, confirmSwitch: true, meta });
      expect(result).toMatchObject({ ok: false, status: 409, code: 'SHIFT_IN_PROGRESS', extra: { registeredName: 'Ana Reyes' } });
      expect(mockShiftStatus).toHaveBeenCalledWith('userA');
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockGenerateToken).not.toHaveBeenCalled();
    });

    it('rebinds on confirmation, rotates the secret and audits it', async () => {
      const { secret, doc, code } = arrange();
      const result: any = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, confirmSwitch: true, meta });
      expect(result).toMatchObject({ ok: true, token: 'token:userB:12h', switched: true, user: { id: 'userB' } });
      expect(result.credentials.deviceId).toBe(doc.deviceId);
      expect(result.credentials.deviceSecret).not.toBe(secret);
      const [filter, update] = mockDeviceUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'dev1' });
      expect(update.$set.userId).toBe('userB');
      expect(update.$set.secretHash).toBe(hashSecret(result.credentials.deviceSecret));
      expect(update.$set.secretHash).not.toBe(doc.secretHash);
      expect(update.$inc).toEqual({ credentialVersion: 1 });
      expect(update.$push.events.$each[0].type).toBe('rebound');
      expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'TrayDevice', action: 'TRAY_DEVICE_REBOUND' }));
    });

    it('refuses a switch when the code was consumed in the meantime', async () => {
      const { secret, doc, code } = arrange();
      mockCodeFindOneAndUpdate.mockResolvedValue(null);
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, confirmSwitch: true, meta });
      expect(result).toMatchObject({ ok: false, status: 401, code: 'CODE_INVALID' });
      expect(mockDeviceUpdateOne).not.toHaveBeenCalled();
    });

    it('refuses to switch to a disabled account', async () => {
      const { secret, doc, code } = arrange();
      usersById.userB = { ...userB, isActive: false };
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, confirmSwitch: true, meta });
      expect(result).toMatchObject({ ok: false, code: 'USER_DISABLED' });
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
      usersById.userB = userB;
    });
  });

  describe('registration', () => {
    it('registers a new device with a valid code and stores only the hash', async () => {
      const code = generateBootstrapCode();
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      setDevice(null);
      const result: any = await connectDevice({ bootstrapCode: code, meta });
      expect(result).toMatchObject({ ok: true, registered: true, token: 'token:userA:12h' });
      expect(result.credentials.deviceSecret.length).toBeGreaterThanOrEqual(43);
      const created = mockDeviceCreate.mock.calls[0][0];
      expect(created.secretHash).toBe(hashSecret(result.credentials.deviceSecret));
      expect(JSON.stringify(created)).not.toContain(result.credentials.deviceSecret);
      expect(created).toMatchObject({ userId: 'userA', organizationId: 'org1', label: 'DESKTOP-ABC', platform: 'win32' });
      expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({ action: 'TRAY_DEVICE_REGISTERED' }));
    });

    it('registers again after a revoked device when a fresh code arrives', async () => {
      const revoked = makeDevice({ revokedAt: new Date() });
      const code = generateBootstrapCode();
      setDevice(revoked.doc);
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      const result: any = await connectDevice({ deviceId: revoked.doc.deviceId, deviceSecret: revoked.secret, bootstrapCode: code, meta });
      expect(result).toMatchObject({ ok: true, registered: true });
      expect(result.credentials.deviceId).not.toBe(revoked.doc.deviceId);
    });

    it('reports first-time setup when there is no device and no valid code', async () => {
      expect(await connectDevice({ meta })).toMatchObject({ ok: false, status: 401, code: 'NEEDS_SETUP' });
      mockCodeFindOne.mockReturnValue(chain(null));
      expect(await connectDevice({ bootstrapCode: generateBootstrapCode(), meta })).toMatchObject({ code: 'NEEDS_SETUP' });
      expect(await connectDevice({ bootstrapCode: 'short', meta })).toMatchObject({ code: 'NEEDS_SETUP' });
      expect(mockDeviceCreate).not.toHaveBeenCalled();
    });

    it('never registers twice from the same single-use code', async () => {
      const code = generateBootstrapCode();
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      mockCodeFindOneAndUpdate.mockResolvedValueOnce({ _id: 'code1' }).mockResolvedValueOnce(null);
      const first = await connectDevice({ bootstrapCode: code, meta });
      const second = await connectDevice({ bootstrapCode: code, meta });
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: false, code: 'CODE_INVALID' });
      expect(mockDeviceCreate).toHaveBeenCalledTimes(1);
    });

    it('does not register while the flag is off for the code owner', async () => {
      process.env.TRAY_DEVICE_AUTH = 'someone-else';
      const code = generateBootstrapCode();
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      expect(await connectDevice({ bootstrapCode: code, meta })).toMatchObject({ ok: false, code: 'TRAY_DEVICE_AUTH_OFF' });
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockDeviceCreate).not.toHaveBeenCalled();
    });

    it('revokes the least recently used device when the per-user limit is reached', async () => {
      const code = generateBootstrapCode();
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      const active = Array.from({ length: 5 }, (_, i) => ({ _id: `old${i}`, deviceId: generateDeviceId(), userId: 'userA', organizationId: 'org1' }));
      mockDeviceFind.mockReturnValue(chain(active));
      await connectDevice({ bootstrapCode: code, meta });
      expect(mockDeviceUpdateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = mockDeviceUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: 'old0' });
      expect(update.$set.revokedReason).toBe('device_limit');
    });
  });

  describe('issueBootstrapCode and registerDeviceFromSession', () => {
    it('stores only the hash of the code and expires it after 90 seconds', async () => {
      const result = await issueBootstrapCode({ _id: 'userA', organizationId: 'org1' });
      expect(result.expiresInSec).toBe(90);
      const stored = mockCodeCreate.mock.calls[0][0];
      expect(stored.codeHash).toBe(hashSecret(result.code));
      expect(JSON.stringify(stored)).not.toContain(result.code);
      const ttlMs = stored.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(85_000);
      expect(ttlMs).toBeLessThanOrEqual(90_000);
    });

    it('registers a device for an authenticated tray session', async () => {
      const creds = await registerDeviceFromSession(userA, meta);
      expect(creds.deviceId).toMatch(/^td_/);
      expect(mockDeviceCreate.mock.calls[0][0].secretHash).toBe(hashSecret(creds.deviceSecret));
    });
  });

  describe('disconnect and revoke', () => {
    it('disconnects with valid credentials and is idempotent', async () => {
      const { secret, doc } = makeDevice();
      setDevice(doc);
      expect(await disconnectDevice(doc.deviceId, secret)).toBe('ok');
      expect(mockDeviceUpdateOne.mock.calls[0][1].$set.revokedReason).toBe('disconnected_by_device');
      mockDeviceUpdateOne.mockClear();
      setDevice({ ...doc, revokedAt: new Date() });
      expect(await disconnectDevice(doc.deviceId, secret)).toBe('ok');
      expect(mockDeviceUpdateOne).not.toHaveBeenCalled();
    });

    it('rejects a disconnect with the wrong secret', async () => {
      const { doc } = makeDevice();
      setDevice(doc);
      expect(await disconnectDevice(doc.deviceId, generateDeviceSecret())).toBe('unknown');
      expect(await disconnectDevice('bad', 'bad')).toBe('unknown');
      expect(mockDeviceUpdateOne).not.toHaveBeenCalled();
    });

    it('lets the owner or an admin of the same organization revoke, and nobody else', async () => {
      const { doc } = makeDevice();
      setDevice(doc);
      expect(await revokeDeviceById(doc.deviceId, { id: 'userA', role: 'employee', organizationId: 'org1' })).toBe('ok');
      expect(mockDeviceUpdateOne.mock.calls[0][1].$set.revokedReason).toBe('revoked_by_owner');
      expect(await revokeDeviceById(doc.deviceId, { id: 'admin1', role: 'admin', organizationId: 'org1' })).toBe('ok');
      expect(mockDeviceUpdateOne.mock.calls[1][1].$set.revokedReason).toBe('revoked_by_admin');
      mockDeviceUpdateOne.mockClear();
      expect(await revokeDeviceById(doc.deviceId, { id: 'admin2', role: 'admin', organizationId: 'org2' })).toBe('forbidden');
      expect(await revokeDeviceById(doc.deviceId, { id: 'userB', role: 'manager', organizationId: 'org1' })).toBe('forbidden');
      expect(mockDeviceUpdateOne).not.toHaveBeenCalled();
      setDevice(null);
      expect(await revokeDeviceById(doc.deviceId, { id: 'userA' })).toBe('not_found');
      expect(await revokeDeviceById('not-an-id', { id: 'userA' })).toBe('not_found');
    });

    it('revokes every active device of a user with a reason', async () => {
      mockDeviceUpdateMany.mockResolvedValue({ modifiedCount: 3 });
      expect(await revokeUserTrayDevices('userA', 'user_offboarded')).toBe(3);
      const [filter, update] = mockDeviceUpdateMany.mock.calls[0];
      expect(filter).toEqual({ userId: 'userA', revokedAt: null });
      expect(update.$set.revokedReason).toBe('user_offboarded');
    });

    it('finds the linked account by lowercase email and organization', async () => {
      mockCrmFindOne.mockReturnValue(chain({ _id: 'userA' }));
      mockDeviceUpdateMany.mockResolvedValue({ modifiedCount: 1 });
      expect(await revokeTrayDevicesForEmail('Ana@Example.com', 'org1', 'org_membership_removed')).toBe(1);
      expect(mockCrmFindOne).toHaveBeenCalledWith({ email: 'ana@example.com', organizationId: 'org1' });
      mockCrmFindOne.mockReturnValue(chain(null));
      expect(await revokeTrayDevicesForEmail('nobody@example.com', 'org1', 'x')).toBe(0);
      expect(await revokeTrayDevicesForEmail('', 'org1', 'x')).toBe(0);
    });
  });

  describe('registration preview', () => {
    it('names the account without consuming the code, creating a device or minting a token', async () => {
      const code = generateBootstrapCode();
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      const result = await connectDevice({ bootstrapCode: code, preview: true, meta });
      expect(result).toEqual({ ok: true, preview: { websiteName: 'Ana Reyes', websiteUserId: 'userA' } });
      expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockDeviceCreate).not.toHaveBeenCalled();
      expect(mockGenerateToken).not.toHaveBeenCalled();
    });

    it('still validates the code, the flag and the account', async () => {
      const code = generateBootstrapCode();
      mockCodeFindOne.mockReturnValue(chain(null));
      expect(await connectDevice({ bootstrapCode: code, preview: true, meta })).toMatchObject({ ok: false, code: 'NEEDS_SETUP' });
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      usersById.userA = { ...userA, isActive: false };
      expect(await connectDevice({ bootstrapCode: code, preview: true, meta })).toMatchObject({ ok: false, code: 'USER_DISABLED' });
      usersById.userA = userA;
      process.env.TRAY_DEVICE_AUTH = 'someone-else';
      expect(await connectDevice({ bootstrapCode: code, preview: true, meta })).toMatchObject({ ok: false, code: 'TRAY_DEVICE_AUTH_OFF' });
    });

    it('is ignored for an already registered device and the same user', async () => {
      const { secret, doc } = makeDevice();
      const code = generateBootstrapCode();
      setDevice(doc);
      setCode(code, { userId: 'userA', organizationId: 'org1' });
      const result = await connectDevice({ deviceId: doc.deviceId, deviceSecret: secret, bootstrapCode: code, preview: true, meta });
      expect(result).toMatchObject({ ok: true, token: 'token:userA:12h' });
    });
  });

  describe('getTrayDeviceStatus', () => {
    it('reports registration and whether the tray heartbeat is recent', async () => {
      mockDeviceFind.mockReturnValue(chain([{ deviceId: 'td_x', label: 'PC', platform: 'win32', appVersion: '1.5.5', lastSeenAt: new Date(), createdAt: new Date() }]));
      mockHeartbeatFindOne.mockReturnValue(chain({ lastSeenAt: new Date() }));
      expect(await getTrayDeviceStatus('userA')).toMatchObject({ registered: true, online: true, devices: [{ deviceId: 'td_x' }] });
      mockHeartbeatFindOne.mockReturnValue(chain({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }));
      expect((await getTrayDeviceStatus('userA')).online).toBe(false);
      mockDeviceFind.mockReturnValue(chain([]));
      mockHeartbeatFindOne.mockReturnValue(chain(null));
      expect(await getTrayDeviceStatus('userA')).toEqual({ registered: false, online: false, devices: [] });
    });
  });
});
