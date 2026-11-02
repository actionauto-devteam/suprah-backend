type Heartbeat = { activeTrayId: string | null; activeTraySegmentId: string | null; standbyAlertKey: string | null } | null;

let lastLog: { _id: string; type: string } | null = null;
let heartbeat: Heartbeat = null;

const chain = <T>(value: () => T) => ({
  sort: () => chain(value),
  select: () => chain(value),
  lean: async () => value(),
});

const mockFireShiftAlert = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/models/TimeLog.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(() => chain(() => lastLog)) },
}));

jest.mock('../../src/models/AgentHeartbeat.model', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(() => chain(() => heartbeat)),
    findOneAndUpdate: jest.fn((filter: { $or: Array<Record<string, unknown>> }, update: { $set: { activeTrayId: string; activeTraySegmentId: string } }) => {
      const set = update.$set;
      const matches = !heartbeat
        || heartbeat.activeTraySegmentId !== set.activeTraySegmentId
        || heartbeat.activeTrayId === null
        || heartbeat.activeTrayId === set.activeTrayId;
      if (matches) {
        heartbeat = { ...(heartbeat ?? { standbyAlertKey: null }), activeTrayId: set.activeTrayId, activeTraySegmentId: set.activeTraySegmentId } as Heartbeat;
        return chain(() => heartbeat);
      }
      const err = Object.assign(new Error('dup'), { code: 11000 });
      return { select: () => ({ lean: async () => { throw err; } }) };
    }),
    updateOne: jest.fn(async (_filter: unknown, update: { $set: { standbyAlertKey: string } }) => {
      if (heartbeat && heartbeat.standbyAlertKey === update.$set.standbyAlertKey) return { modifiedCount: 0 };
      heartbeat = { ...(heartbeat as NonNullable<Heartbeat>), standbyAlertKey: update.$set.standbyAlertKey };
      return { modifiedCount: 1 };
    }),
  },
}));

jest.mock('../../src/services/shiftAlerts.service', () => ({ fireShiftAlert: mockFireShiftAlert }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { checkTrayAccess, readTrayId } from '../../src/services/trayClaim.service';

const TRAY_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const TRAY_B = 'bbbbbbbb-1111-2222-3333-444444444444';

const req = (trayId?: string) => ({ headers: trayId ? { 'x-tray-id': trayId } : {} }) as never;

const check = (trayId: string | undefined, inputAgeSec?: number) => checkTrayAccess({
  req: req(trayId),
  userId: 'user1',
  userModel: 'CrmUser',
  organizationId: 'org1',
  displayName: 'Charmi Rimando',
  inputAgeSec,
});

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  lastLog = { _id: 'timein1', type: 'time-in' };
  heartbeat = null;
  mockFireShiftAlert.mockClear();
});

describe('readTrayId', () => {
  it('accepts a normal id and rejects junk', () => {
    expect(readTrayId(req(TRAY_A))).toBe(TRAY_A);
    expect(readTrayId(req('bad id!'))).toBeNull();
    expect(readTrayId(req())).toBeNull();
  });
});

describe('checkTrayAccess', () => {
  it('lets old trays without an id through unchanged', async () => {
    expect(await check(undefined, 5)).toBe(true);
    expect(heartbeat).toBeNull();
  });

  it('does nothing while the user is not tracking (clocked out or on break)', async () => {
    lastLog = { _id: 'out1', type: 'time-out' };
    expect(await check(TRAY_A, 5)).toBe(true);
    lastLog = { _id: 'bin1', type: 'break-in' };
    expect(await check(TRAY_B, 5)).toBe(true);
    expect(heartbeat).toBeNull();
  });

  it('gives the shift to the computer that is actually being used', async () => {
    expect(await check(TRAY_B, 900)).toBe(true);
    expect(heartbeat).toBeNull();
    expect(await check(TRAY_A, 3)).toBe(true);
    expect(heartbeat?.activeTrayId).toBe(TRAY_A);
  });

  it('puts the second computer on standby and alerts admins only once per shift segment', async () => {
    await check(TRAY_A, 3);
    expect(await check(TRAY_B, 0)).toBe(false);
    expect(await check(TRAY_B, 900)).toBe(false);
    await flush();
    expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    expect(mockFireShiftAlert.mock.calls[0][0].chatMessage).toContain('second computer');
  });

  it('keeps accepting the active computer, including uploads that carry no input age', async () => {
    await check(TRAY_A, 3);
    expect(await check(TRAY_A)).toBe(true);
    expect(await check(TRAY_A, 5000)).toBe(true);
  });

  it('lets the user switch computers after a break', async () => {
    await check(TRAY_A, 3);
    expect(await check(TRAY_B, 2)).toBe(false);
    lastLog = { _id: 'bout1', type: 'break-out' };
    expect(await check(TRAY_B, 2)).toBe(true);
    expect(heartbeat?.activeTrayId).toBe(TRAY_B);
    expect(await check(TRAY_A, 1)).toBe(false);
  });

  it('lets the user switch computers after clocking out and back in', async () => {
    await check(TRAY_A, 3);
    lastLog = { _id: 'timein2', type: 'time-in' };
    expect(await check(TRAY_B, 10)).toBe(true);
    expect(heartbeat?.activeTraySegmentId).toBe('timein2');
  });
});
