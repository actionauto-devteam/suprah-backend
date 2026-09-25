const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockStatus = jest.fn();
const mockBootstrap = jest.fn();
const mockRegisterSession = jest.fn();
const mockRevokeById = jest.fn();

jest.mock('../../src/services/trayDevice.service', () => ({
  connectDevice: mockConnect,
  disconnectDevice: mockDisconnect,
  getTrayDeviceStatus: mockStatus,
  issueBootstrapCode: mockBootstrap,
  registerDeviceFromSession: mockRegisterSession,
  revokeDeviceById: mockRevokeById,
}));

import trayDeviceController from '../../src/controllers/trayDevice.controller';

const savedEnv = { ...process.env };

const run = async (handler: (...args: any[]) => unknown, req: Record<string, unknown>) => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const next = jest.fn();
  handler(req, { json, status }, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next, ok: json.mock.calls[0]?.[0], failureStatus: status.mock.calls[0]?.[0] };
};

const crmUser = { _id: 'userA', role: 'employee', organizationId: 'org1' };

describe('trayDevice.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv, TRAY_DEVICE_AUTH: 'all' };
    delete process.env.TRAY_DEVICE_AUTH_DISABLED;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('connect', () => {
    it('returns the token and user, and includes credentials only when they exist', async () => {
      mockConnect.mockResolvedValueOnce({ ok: true, token: 'tok', user: { id: 'userA', fullName: 'Ana' } });
      const plain = await run(trayDeviceController.connect, { body: { deviceId: 'd', deviceSecret: 's' } });
      expect(plain.ok.data).toEqual({ token: 'tok', user: { id: 'userA', fullName: 'Ana' } });

      mockConnect.mockResolvedValueOnce({
        ok: true,
        token: 'tok',
        user: { id: 'userA', fullName: 'Ana' },
        credentials: { deviceId: 'td_1', deviceSecret: 'secret' },
        registered: true,
      });
      const registered = await run(trayDeviceController.connect, { body: { bootstrapCode: 'c' } });
      expect(registered.ok.data).toMatchObject({ credentials: { deviceId: 'td_1', deviceSecret: 'secret' }, registered: true });
    });

    it('passes sanitized metadata and only an explicit true as confirmSwitch', async () => {
      mockConnect.mockResolvedValue({ ok: true, token: 't', user: { id: 'u', fullName: '' } });
      await run(trayDeviceController.connect, {
        body: { deviceId: 'd', deviceSecret: 's', bootstrapCode: 'c', confirmSwitch: 'true', label: '  PC \n', platform: 'WIN32', appVersion: '1.5.5' },
      });
      expect(mockConnect).toHaveBeenLastCalledWith({
        deviceId: 'd',
        deviceSecret: 's',
        bootstrapCode: 'c',
        confirmSwitch: false,
        preview: false,
        meta: { label: 'PC', platform: 'win32', appVersion: '1.5.5' },
      });
      await run(trayDeviceController.connect, { body: { confirmSwitch: true } });
      expect(mockConnect.mock.calls[1][0].confirmSwitch).toBe(true);
    });

    it('returns a preview result without a token and only honors an explicit true', async () => {
      mockConnect.mockResolvedValue({ ok: true, preview: { websiteName: 'Ana' } });
      const result = await run(trayDeviceController.connect, { body: { bootstrapCode: 'c', preview: true } });
      expect(result.ok.data).toEqual({ preview: { websiteName: 'Ana' } });
      expect(mockConnect.mock.calls[0][0].preview).toBe(true);
      await run(trayDeviceController.connect, { body: { bootstrapCode: 'c', preview: 'true' } });
      expect(mockConnect.mock.calls[1][0].preview).toBe(false);
    });

    it('tolerates a missing body', async () => {
      mockConnect.mockResolvedValue({ ok: false, status: 401, code: 'NEEDS_SETUP', message: 'setup' });
      const result = await run(trayDeviceController.connect, {});
      expect(result.failureStatus).toBe(401);
      expect(result.next).not.toHaveBeenCalled();
    });

    it('passes failures through with the machine code and extra fields', async () => {
      mockConnect.mockResolvedValue({
        ok: false,
        status: 409,
        code: 'ACCOUNT_MISMATCH',
        message: 'different',
        extra: { registeredName: 'Ana', websiteName: 'Ben' },
      });
      const result = await run(trayDeviceController.connect, { body: {} });
      expect(result.failureStatus).toBe(409);
      expect(result.json).toHaveBeenCalledWith({
        success: false,
        code: 'ACCOUNT_MISMATCH',
        message: 'different',
        registeredName: 'Ana',
        websiteName: 'Ben',
      });
    });
  });

  describe('disconnect', () => {
    it('confirms a valid disconnect and rejects unknown credentials', async () => {
      mockDisconnect.mockResolvedValueOnce('ok');
      const ok = await run(trayDeviceController.disconnect, { body: { deviceId: 'd', deviceSecret: 's' } });
      expect(ok.ok.data).toEqual({ disconnected: true });
      mockDisconnect.mockResolvedValueOnce('unknown');
      const unknown = await run(trayDeviceController.disconnect, { body: {} });
      expect(unknown.failureStatus).toBe(401);
      expect(unknown.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEVICE_UNKNOWN' }));
    });
  });

  describe.each([
    ['status', () => trayDeviceController.status, mockStatus, { registered: true, online: false, devices: [] }],
    ['bootstrap', () => trayDeviceController.bootstrap, mockBootstrap, { code: 'abc', expiresInSec: 90 }],
    ['registerSession', () => trayDeviceController.registerSession, mockRegisterSession, { deviceId: 'td_1', deviceSecret: 's' }],
  ])('%s', (_name, getHandler, mockFn, value) => {
    it('returns data when the flag is on for the user', async () => {
      mockFn.mockResolvedValue(value);
      const result = await run(getHandler(), { crmUser, body: {} });
      expect(result.next).not.toHaveBeenCalled();
      expect(JSON.stringify(result.ok.data)).toContain(Object.keys(value)[0]);
    });

    it('answers 403 TRAY_DEVICE_AUTH_OFF and does no work while the flag is off', async () => {
      process.env.TRAY_DEVICE_AUTH = 'someone-else';
      const result = await run(getHandler(), { crmUser, body: {} });
      expect(result.failureStatus).toBe(403);
      expect(result.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TRAY_DEVICE_AUTH_OFF' }));
      expect(mockFn).not.toHaveBeenCalled();
    });

    it('serves a user set to on even when the environment allowlist does not include them', async () => {
      process.env.TRAY_DEVICE_AUTH = 'someone-else';
      mockFn.mockResolvedValue(value);
      const result = await run(getHandler(), { crmUser: { ...crmUser, trayDeviceAuthOverride: 'on' }, body: {} });
      expect(result.failureStatus).toBeUndefined();
      expect(mockFn).toHaveBeenCalled();
    });

    it('refuses a user set to off even when the environment says all', async () => {
      process.env.TRAY_DEVICE_AUTH = 'all';
      const result = await run(getHandler(), { crmUser: { ...crmUser, trayDeviceAuthOverride: 'off' }, body: {} });
      expect(result.failureStatus).toBe(403);
      expect(result.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TRAY_DEVICE_AUTH_OFF' }));
      expect(mockFn).not.toHaveBeenCalled();
    });

    it('keeps the kill switch stronger than a user set to on', async () => {
      process.env.TRAY_DEVICE_AUTH_DISABLED = 'true';
      const result = await run(getHandler(), { crmUser: { ...crmUser, trayDeviceAuthOverride: 'on' }, body: {} });
      expect(result.failureStatus).toBe(403);
      expect(result.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TRAY_DEVICE_AUTH_DISABLED' }));
      expect(mockFn).not.toHaveBeenCalled();
    });

    it('answers 403 with the disabled code when the kill switch is on, never a 503 the website would show as an outage', async () => {
      process.env.TRAY_DEVICE_AUTH_DISABLED = 'true';
      const result = await run(getHandler(), { crmUser, body: {} });
      expect(result.failureStatus).toBe(403);
      expect(result.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TRAY_DEVICE_AUTH_DISABLED' }));
      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  describe('registerSession', () => {
    it('wraps the credentials and sanitizes the metadata', async () => {
      mockRegisterSession.mockResolvedValue({ deviceId: 'td_1', deviceSecret: 's' });
      const result = await run(trayDeviceController.registerSession, {
        crmUser,
        body: { label: ' PC ', platform: 'DARWIN', appVersion: '1.5.5' },
      });
      expect(result.ok.data).toEqual({ credentials: { deviceId: 'td_1', deviceSecret: 's' } });
      expect(mockRegisterSession).toHaveBeenCalledWith(crmUser, { label: 'PC', platform: 'darwin', appVersion: '1.5.5' });
    });
  });

  describe('revoke', () => {
    it('maps every outcome to the right response', async () => {
      mockRevokeById.mockResolvedValueOnce('ok');
      const ok = await run(trayDeviceController.revoke, { crmUser, params: { deviceId: 'td_x' } });
      expect(ok.ok.data).toEqual({ revoked: true });
      expect(mockRevokeById).toHaveBeenCalledWith('td_x', { id: 'userA', role: 'employee', organizationId: 'org1' });

      mockRevokeById.mockResolvedValueOnce('not_found');
      const missing = await run(trayDeviceController.revoke, { crmUser, params: { deviceId: 'td_x' } });
      expect(missing.next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });

      mockRevokeById.mockResolvedValueOnce('forbidden');
      const forbidden = await run(trayDeviceController.revoke, { crmUser, params: { deviceId: 'td_x' } });
      expect(forbidden.next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    });
  });
});
