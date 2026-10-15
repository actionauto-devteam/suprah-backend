const mockFind = jest.fn();
const mockUpdateOne = jest.fn();
const mockCreateNotification = jest.fn();

jest.mock('node-cron', () => ({ __esModule: true, default: { schedule: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: mockCreateNotification },
}));
jest.mock('../../src/models/DriverProfile.model', () => {
  const actual = jest.requireActual('../../src/models/DriverProfile.model');
  return {
    __esModule: true,
    ...actual,
    default: { find: mockFind, updateOne: mockUpdateOne },
  };
});

import {
  dueExpiryReminders,
  expiryReminderText,
  sendCredentialExpiryReminders,
} from '../../src/schedulers/driverCredentialReminder.scheduler';

const DAY = 86_400_000;
// 15:00 UTC = 9:00 AM MDT, inside the daytime sending window.
const now = Date.parse('2026-10-13T15:00:00Z');
const inDays = (days: number) => new Date(now + days * DAY - 60_000);

// DriverProfile.find(...).select(...).lean() resolving to these profiles.
const findReturns = (profiles: unknown[]) =>
  mockFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(profiles) }) });

describe('dueExpiryReminders', () => {
  it('picks the closest step each credential has reached, most urgent first', () => {
    const due = dueExpiryReminders(
      {
        licenseExpirationDate: inDays(20),
        medicalCardExpirationDate: inDays(10),
        insuranceExpirationDate: inDays(2),
      },
      [],
      now,
    );
    expect(due.map((item) => [item.label, item.reminderDays])).toEqual([
      ['insurance', 3],
      ['medical card', 14],
      ['CDL', 30],
    ]);
  });

  it('skips credentials more than 30 days out, already expired, or without a date', () => {
    expect(
      dueExpiryReminders(
        { licenseExpirationDate: inDays(45), medicalCardExpirationDate: new Date(now - DAY) },
        [],
        now,
      ),
    ).toEqual([]);
  });

  it('never repeats a step already sent for the same expiration day', () => {
    const profile = { licenseExpirationDate: inDays(10) };
    const [first] = dueExpiryReminders(profile, [], now);
    expect(first.key).toBe(`CDL:${first.date}:14`);
    expect(dueExpiryReminders(profile, [first.key], now)).toEqual([]);
    // The next step still goes out.
    expect(dueExpiryReminders(profile, [first.key], now + 8 * DAY)[0].reminderDays).toBe(3);
  });

  it('starts over when a renewal moves the expiration date', () => {
    const [old] = dueExpiryReminders({ licenseExpirationDate: inDays(10) }, [], now);
    const renewed = dueExpiryReminders({ licenseExpirationDate: inDays(25) }, [old.key], now);
    expect(renewed).toHaveLength(1);
    expect(renewed[0].reminderDays).toBe(30);
  });
});

describe('expiryReminderText', () => {
  it('says when it expires and what to do, in plain English', () => {
    const text = expiryReminderText({ label: 'CDL', date: '2026-10-27', expired: false, daysLeft: 14 });
    expect(text.title).toBe('Your CDL expires in 14 days');
    expect(text.message).toContain('Oct 27, 2026');
    expect(text.message).toContain('press Replace');
  });

  it('says "tomorrow" on the last day', () => {
    expect(expiryReminderText({ label: 'insurance', date: '2026-10-14', expired: false, daysLeft: 1 }).title).toBe(
      'Your insurance expires tomorrow',
    );
  });
});

describe('sendCredentialExpiryReminders', () => {
  const profile = {
    _id: 'profile-1',
    userId: 'user-1',
    organizationId: 'org-1',
    licenseExpirationDate: inDays(10),
    complianceRemindersSent: [] as string[],
  };

  beforeEach(() => {
    mockFind.mockReset();
    mockUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
    mockCreateNotification.mockReset().mockResolvedValue({ _id: 'notification-1' });
    findReturns([profile]);
  });

  it('only sends between 8:00 AM and 7:59 PM Mountain Time', async () => {
    // 7:59 AM MDT and 8:00 PM MDT: nothing is sent or even looked up.
    await expect(sendCredentialExpiryReminders(Date.parse('2026-10-13T13:59:00Z'))).resolves.toBe(0);
    await expect(sendCredentialExpiryReminders(Date.parse('2026-10-14T02:00:00Z'))).resolves.toBe(0);
    expect(mockFind).not.toHaveBeenCalled();
    // 8:00 AM MDT and 7:59 PM MDT: sent.
    await expect(sendCredentialExpiryReminders(Date.parse('2026-10-13T14:00:00Z'))).resolves.toBe(1);
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    await expect(sendCredentialExpiryReminders(Date.parse('2026-10-14T01:59:00Z'))).resolves.toBe(1);
  });

  it('does nothing overnight', async () => {
    await expect(sendCredentialExpiryReminders(Date.parse('2026-10-13T08:00:00Z'))).resolves.toBe(0);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('claims the reminder, then notifies the driver with a link to Documents', async () => {
    await expect(sendCredentialExpiryReminders(now)).resolves.toBe(1);
    const key = expect.stringMatching(/^CDL:\d{4}-\d{2}-\d{2}:14$/);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'profile-1', complianceRemindersSent: { $ne: key } },
      { $addToSet: { complianceRemindersSent: key } },
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        organizationId: 'org-1',
        type: 'driver_document_expiring',
        title: 'Your CDL expires in 10 days',
        metadata: expect.objectContaining({ route: '/driver/documents' }),
      }),
    );
  });

  it('skips a reminder another run already claimed', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(sendCredentialExpiryReminders(now)).resolves.toBe(0);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('releases the claim when sending fails, so the next run retries', async () => {
    mockCreateNotification.mockRejectedValue(Object.assign(new Error('push down'), { statusCode: 500 }));
    await expect(sendCredentialExpiryReminders(now)).resolves.toBe(0);
    expect(mockUpdateOne).toHaveBeenLastCalledWith(
      { _id: 'profile-1' },
      { $pull: { complianceRemindersSent: expect.stringMatching(/^CDL:/) } },
    );
  });

  it('keeps the claim when the driver account no longer exists', async () => {
    mockCreateNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 404 }));
    await sendCredentialExpiryReminders(now);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });
});
