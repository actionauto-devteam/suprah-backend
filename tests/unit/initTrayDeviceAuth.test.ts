const mockLogger = { info: jest.fn(), error: jest.fn() };
const mockDevice = { collection: { name: 'traydevices' }, createIndexes: jest.fn(), listIndexes: jest.fn() };
const mockCode = { collection: { name: 'traybootstrapcodes' }, createIndexes: jest.fn(), listIndexes: jest.fn() };

jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));
jest.mock('../../src/models/TrayDevice.model', () => ({ __esModule: true, default: mockDevice }));
jest.mock('../../src/models/TrayBootstrapCode.model', () => ({ __esModule: true, default: mockCode }));

import { ensureTrayDeviceIndexes, initTrayDeviceAuth } from '../../src/utils/initTrayDeviceAuth';

const goodDevice = [
  { key: { _id: 1 } },
  { key: { deviceId: 1 }, unique: true },
  { key: { userId: 1 } },
  { key: { userId: 1, revokedAt: 1 } },
];
const goodCode = [
  { key: { _id: 1 } },
  { key: { codeHash: 1 }, unique: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  { key: { userId: 1 } },
];

const resetMocks = () => {
  jest.clearAllMocks();
  mockDevice.createIndexes.mockResolvedValue(undefined);
  mockCode.createIndexes.mockResolvedValue(undefined);
  mockDevice.listIndexes.mockResolvedValue(goodDevice);
  mockCode.listIndexes.mockResolvedValue(goodCode);
};

const noDatabaseCalls = () => {
  expect(mockDevice.createIndexes).not.toHaveBeenCalled();
  expect(mockCode.createIndexes).not.toHaveBeenCalled();
  expect(mockDevice.listIndexes).not.toHaveBeenCalled();
  expect(mockCode.listIndexes).not.toHaveBeenCalled();
};

describe('ensureTrayDeviceIndexes', () => {
  beforeEach(resetMocks);

  it('is read-only by default: it lists indexes and never creates any', async () => {
    expect(await ensureTrayDeviceIndexes()).toEqual([]);
    expect(await ensureTrayDeviceIndexes({ create: false })).toEqual([]);
    expect(mockDevice.createIndexes).not.toHaveBeenCalled();
    expect(mockCode.createIndexes).not.toHaveBeenCalled();
    expect(mockDevice.listIndexes).toHaveBeenCalledTimes(2);
  });

  it('creates both collections\' indexes only when explicitly asked, then verifies them', async () => {
    expect(await ensureTrayDeviceIndexes({ create: true })).toEqual([]);
    expect(mockDevice.createIndexes).toHaveBeenCalledTimes(1);
    expect(mockCode.createIndexes).toHaveBeenCalledTimes(1);
    expect(mockDevice.listIndexes).toHaveBeenCalledTimes(1);
  });

  it('names the collection for every missing index', async () => {
    mockDevice.listIndexes.mockResolvedValue([{ key: { _id: 1 } }, { key: { deviceId: 1 } }]);
    const problems = await ensureTrayDeviceIndexes();
    expect(problems).toContain('traydevices: index {deviceId:1} exists but is not unique');
    expect(problems).toContain('traydevices: missing index {userId:1}');
    expect(problems.every((problem) => problem.startsWith('traydevices:'))).toBe(true);
  });

  it('treats a collection that does not exist yet as fully missing rather than crashing', async () => {
    mockCode.listIndexes.mockRejectedValue({ code: 26, codeName: 'NamespaceNotFound' });
    const problems = await ensureTrayDeviceIndexes();
    expect(problems).toEqual([
      'traybootstrapcodes: missing index {codeHash:1} (unique)',
      'traybootstrapcodes: missing index {expiresAt:1} (TTL)',
      'traybootstrapcodes: missing index {userId:1}',
    ]);
  });

  it('propagates unexpected database errors to the caller', async () => {
    mockDevice.listIndexes.mockRejectedValue(new Error('not authorized'));
    await expect(ensureTrayDeviceIndexes()).rejects.toThrow('not authorized');
  });
});

describe('initTrayDeviceAuth', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    resetMocks();
    process.env = { ...savedEnv };
    delete process.env.TRAY_DEVICE_AUTH;
    delete process.env.TRAY_DEVICE_AUTH_DISABLED;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it.each([
    [undefined, 'off'],
    ['off', 'off'],
    [',', 'off'],
  ])('while the feature is off (TRAY_DEVICE_AUTH=%s) it logs the mode and makes no database call at all', async (value, expected) => {
    if (value !== undefined) process.env.TRAY_DEVICE_AUTH = value;
    await initTrayDeviceAuth();
    expect(mockLogger.info).toHaveBeenCalledWith(`[TrayDevice] device authentication mode: ${expected}`);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    noDatabaseCalls();
  });

  it('the kill switch also means no database call, whatever the allowlist says', async () => {
    process.env.TRAY_DEVICE_AUTH = 'all';
    process.env.TRAY_DEVICE_AUTH_DISABLED = 'true';
    await initTrayDeviceAuth();
    expect(mockLogger.info).toHaveBeenCalledWith('[TrayDevice] device authentication mode: killed');
    noDatabaseCalls();
  });

  it('never prints the allowlisted user ids', async () => {
    process.env.TRAY_DEVICE_AUTH = '64a1b2c3d4e5f60718293a4b';
    await initTrayDeviceAuth();
    const lines = mockLogger.info.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[TrayDevice] device authentication mode: allowlist of 1 user(s)');
    expect(lines.join(' ')).not.toContain('64a1b2c3d4e5f60718293a4b');
  });

  it.each([
    ['64a1b2c3d4e5f60718293a4b', 'allowlist of 1 user(s)'],
    ['all', 'all'],
  ])('when enabled (TRAY_DEVICE_AUTH=%s) it only reads: verifies the indexes and never creates any', async (value, description) => {
    process.env.TRAY_DEVICE_AUTH = value;
    await initTrayDeviceAuth();
    expect(mockLogger.info).toHaveBeenCalledWith(`[TrayDevice] device authentication mode: ${description}`);
    expect(mockLogger.info).toHaveBeenCalledWith('[TrayDevice] MongoDB indexes verified');
    expect(mockDevice.listIndexes).toHaveBeenCalledTimes(1);
    expect(mockCode.listIndexes).toHaveBeenCalledTimes(1);
    expect(mockDevice.createIndexes).not.toHaveBeenCalled();
    expect(mockCode.createIndexes).not.toHaveBeenCalled();
  });

  it('when enabled and an index is missing it logs an error that names the fix, never creates it, and never throws', async () => {
    process.env.TRAY_DEVICE_AUTH = 'all';
    mockCode.listIndexes.mockResolvedValue([{ key: { _id: 1 } }]);
    await expect(initTrayDeviceAuth()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ problems: expect.arrayContaining(['traybootstrapcodes: missing index {codeHash:1} (unique)']) }),
      '[TrayDevice] required MongoDB indexes are missing; run verify-tray-device-indexes --create',
    );
    expect(mockCode.createIndexes).not.toHaveBeenCalled();
  });

  it('when enabled and the database read fails it logs an error and never throws', async () => {
    process.env.TRAY_DEVICE_AUTH = 'all';
    mockDevice.listIndexes.mockRejectedValue(new Error('not authorized'));
    await expect(initTrayDeviceAuth()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), '[TrayDevice] could not verify MongoDB indexes');
  });
});
