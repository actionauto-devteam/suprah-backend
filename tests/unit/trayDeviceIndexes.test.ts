import TrayDevice from '../../src/models/TrayDevice.model';
import TrayBootstrapCode from '../../src/models/TrayBootstrapCode.model';
import {
  REQUIRED_TRAY_BOOTSTRAP_INDEXES,
  REQUIRED_TRAY_DEVICE_INDEXES,
  findIndexProblems,
} from '../../src/utils/trayDeviceIndexes.util';
import type { ActualIndex } from '../../src/utils/trayDeviceIndexes.util';

const fromSchema = (model: any): ActualIndex[] => [
  { name: '_id_', key: { _id: 1 } },
  ...model.schema.indexes().map(([key, options]: [Record<string, unknown>, Record<string, any>]) => ({
    key,
    unique: options?.unique,
    expireAfterSeconds: options?.expireAfterSeconds,
  })),
];

describe('models declare every required index', () => {
  it('TrayDevice: unique deviceId, userId and the userId+revokedAt lookup', () => {
    expect(findIndexProblems(REQUIRED_TRAY_DEVICE_INDEXES, fromSchema(TrayDevice))).toEqual([]);
  });

  it('TrayBootstrapCode: unique codeHash, TTL on expiresAt, userId', () => {
    expect(findIndexProblems(REQUIRED_TRAY_BOOTSTRAP_INDEXES, fromSchema(TrayBootstrapCode))).toEqual([]);
  });

  it('resolves to the collection names the operator will look for', () => {
    expect((TrayDevice as any).collection.name).toBe('traydevices');
    expect((TrayBootstrapCode as any).collection.name).toBe('traybootstrapcodes');
  });

  it('both device-auth schemas are dormant: no automatic index build and no automatic collection creation', () => {
    for (const model of [TrayDevice, TrayBootstrapCode] as any[]) {
      expect(model.schema.options.autoIndex).toBe(false);
      expect(model.schema.options.autoCreate).toBe(false);
    }
  });

  it('a device is never TTL-deleted by the database (expired devices stay for the audit trail)', () => {
    const ttl = fromSchema(TrayDevice).filter((index) => index.expireAfterSeconds !== undefined);
    expect(ttl).toEqual([]);
  });
});

describe('findIndexProblems', () => {
  const complete: ActualIndex[] = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'codeHash_1', key: { codeHash: 1 }, unique: true },
    { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { name: 'userId_1', key: { userId: 1 } },
  ];

  it('accepts a complete set', () => {
    expect(findIndexProblems(REQUIRED_TRAY_BOOTSTRAP_INDEXES, complete)).toEqual([]);
  });

  it('reports every missing index on an empty collection', () => {
    expect(findIndexProblems(REQUIRED_TRAY_BOOTSTRAP_INDEXES, [])).toEqual([
      'missing index {codeHash:1} (unique)',
      'missing index {expiresAt:1} (TTL)',
      'missing index {userId:1}',
    ]);
  });

  it('flags a uniqueness constraint that exists only as a plain index', () => {
    const weakened = complete.map((index) => (index.name === 'codeHash_1' ? { name: 'codeHash_1', key: { codeHash: 1 } } : index));
    expect(findIndexProblems(REQUIRED_TRAY_BOOTSTRAP_INDEXES, weakened)).toEqual(['index {codeHash:1} exists but is not unique']);
  });

  it('flags a TTL index that has the wrong expiry', () => {
    const wrong = complete.map((index) => (index.name === 'expiresAt_1' ? { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 3600 } : index));
    expect(findIndexProblems(REQUIRED_TRAY_BOOTSTRAP_INDEXES, wrong)).toEqual(['index {expiresAt:1} exists but has no TTL of 0s']);
  });

  it('does not confuse a compound index with the single-field one', () => {
    const compoundOnly: ActualIndex[] = [{ name: 'userId_1_revokedAt_1', key: { userId: 1, revokedAt: 1 } }];
    expect(findIndexProblems([{ key: { userId: 1 } }], compoundOnly)).toEqual(['missing index {userId:1}']);
  });
});
