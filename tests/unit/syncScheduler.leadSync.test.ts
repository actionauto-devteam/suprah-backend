const mockSchedules: Array<{ expression: string; task: () => Promise<void> }> = [];
const mockSyncLeadsForOrg = jest.fn();
const mockConfigFind = jest.fn();

jest.mock('node-cron', () => {
  const actual = jest.requireActual('node-cron');
  return {
    __esModule: true,
    default: {
      validate: actual.validate,
      schedule: jest.fn((expression: string, task: () => Promise<void>) => {
        mockSchedules.push({ expression, task });
        return { stop: jest.fn() };
      }),
    },
  };
});
jest.mock('../../src/services/sync.service', () => ({ __esModule: true, default: { syncInventory: jest.fn() } }));
jest.mock('../../src/services/orgGmail.service', () => ({ __esModule: true, default: { syncLeadsForOrg: (...args: any[]) => mockSyncLeadsForOrg(...args) } }));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({ __esModule: true, default: { find: (...args: any[]) => mockConfigFind(...args) } }));
jest.mock('../../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyAllOrganizations: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/config', () => ({ __esModule: true, default: { sync: { schedule: '0 0 * * *' } } }));

function loadLeadSyncTask(cronEnv?: string) {
  mockSchedules.length = 0;
  if (cronEnv === undefined) delete process.env.LEAD_SYNC_CRON;
  else process.env.LEAD_SYNC_CRON = cronEnv;
  jest.isolateModules(() => {
    require('../../src/schedulers/sync.scheduler').initSyncScheduler();
  });
  return mockSchedules[1];
}

describe('lead sync scheduler', () => {
  const savedCron = process.env.LEAD_SYNC_CRON;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockConfigFind.mockReturnValue({ select: jest.fn().mockResolvedValue([{ organizationId: 'org-1' }]) });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (savedCron === undefined) delete process.env.LEAD_SYNC_CRON;
    else process.env.LEAD_SYNC_CRON = savedCron;
  });

  it('checks the lead inbox every minute by default instead of once an hour', () => {
    expect(loadLeadSyncTask().expression).toBe('* * * * *');
  });

  it('uses LEAD_SYNC_CRON when it is a valid schedule and ignores an invalid one', () => {
    expect(loadLeadSyncTask('*/2 * * * *').expression).toBe('*/2 * * * *');
    expect(loadLeadSyncTask('not a schedule').expression).toBe('* * * * *');
  });

  it('never starts a second sync while the previous one is still running', async () => {
    const leadSync = loadLeadSyncTask();
    let finish: (value: { total: number; synced: number }) => void = () => undefined;
    mockSyncLeadsForOrg.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const firstRun = leadSync.task();
    await new Promise((resolve) => setImmediate(resolve));
    await leadSync.task();
    expect(mockSyncLeadsForOrg).toHaveBeenCalledTimes(1);

    finish({ total: 1, synced: 1 });
    await firstRun;
    mockSyncLeadsForOrg.mockResolvedValueOnce({ total: 0, synced: 0 });
    await leadSync.task();
    expect(mockSyncLeadsForOrg).toHaveBeenCalledTimes(2);
  });

  it('keeps running after a failed cycle', async () => {
    const leadSync = loadLeadSyncTask();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockConfigFind.mockReturnValueOnce({ select: jest.fn().mockRejectedValue(new Error('database down')) });
    await leadSync.task();
    mockSyncLeadsForOrg.mockResolvedValueOnce({ total: 0, synced: 0 });
    await leadSync.task();
    expect(mockSyncLeadsForOrg).toHaveBeenCalledTimes(1);
  });
});
