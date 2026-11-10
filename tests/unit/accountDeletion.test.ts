/**
 * Deleting your own account (2026-11-11): who can, what blocks it, and what a
 * deleted account keeps. Models are stand-ins; no database is used.
 */
import Load from '../../src/models/Load.model';
import DriverPayout from '../../src/models/DriverPayout.model';
import Quote from '../../src/models/Quote.model';
import {
  accountDeletionBlocker,
  anonymizedAccountUpdate,
  deletableRole,
  deleteOwnAccount,
  deletionBlockerMessage,
  STAFF_DELETION_MESSAGE,
} from '../../src/services/accountDeletion.service';

const USER_ID = '64b0000000000000000000d1';

/** A stand-in for Model.find(...).select(...).limit(...).lean() and its shorter forms. */
const query = (rows: unknown[]) => {
  const chain: any = {
    select: () => chain,
    limit: () => chain,
    lean: async () => rows,
  };
  return chain;
};

afterEach(() => jest.restoreAllMocks());

describe('who can delete their own account', () => {
  it('drivers and customers; staff are told to ask their dealership', async () => {
    expect(deletableRole('driver')).toBe('driver');
    expect(deletableRole('customer')).toBe('customer');
    for (const role of ['admin', 'employee', 'super_admin', undefined]) expect(deletableRole(role)).toBeNull();

    await expect(deleteOwnAccount({ _id: USER_ID, role: 'admin' })).rejects.toMatchObject({
      statusCode: 403,
      message: STAFF_DELETION_MESSAGE,
    });
    expect(await accountDeletionBlocker({ _id: USER_ID, role: 'employee' })).toBe(STAFF_DELETION_MESSAGE);
  });
});

describe('what a deleted account keeps', () => {
  it('nothing to sign in with and nothing that names the person', () => {
    const update = anonymizedAccountUpdate(USER_ID, 'driver');
    expect(update.$set).toMatchObject({
      name: 'Former driver',
      email: `deleted-${USER_ID}@deleted.suprah.invalid`,
      isActive: false,
      isApproved: false,
      emailVerified: false,
      avatar: null,
      pushSubscriptions: [],
    });
    for (const field of ['password', 'passwordHash', 'googleId', 'personalInfo', 'signatureDataUrl', 'passwordResetToken', 'otpCode']) {
      expect(update.$unset).toHaveProperty(field);
    }
    expect(anonymizedAccountUpdate(USER_ID, 'customer').$set.name).toBe('Former customer');
  });
});

describe('what stops a deletion, in plain words', () => {
  it('a driver with a load in progress or a payout not paid yet', () => {
    expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: ['LD-1042'] })).toBe(
      'You have load LD-1042 in progress. Deliver it or ask dispatch to take it back, then you can delete your account.',
    );
    expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: ['LD-1', 'LD-2'] })).toContain('2 loads (LD-1, LD-2)');
    expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: [], unpaidPayouts: 1 })).toContain("payout that hasn't been paid yet");
    expect(deletionBlockerMessage({ role: 'driver', activeLoadNumbers: [], unpaidPayouts: 0 })).toBeNull();
  });

  it('a customer with a car still being shipped to them', () => {
    expect(deletionBlockerMessage({ role: 'customer', activeShipmentCars: ['2021 Toyota Camry'] })).toBe(
      "Your 2021 Toyota Camry is still being shipped to you. Once it's delivered, you can delete your account.",
    );
    expect(deletionBlockerMessage({ role: 'customer', activeShipmentCars: [] })).toBeNull();
  });

  it("checks the driver's loads and payouts", async () => {
    const find = jest.spyOn(Load, 'find').mockReturnValue(query([{ loadNumber: 'LD-7' }]) as any);
    jest.spyOn(DriverPayout, 'countDocuments').mockResolvedValue(0 as never);
    expect(await accountDeletionBlocker({ _id: USER_ID, role: 'driver' })).toContain('load LD-7 in progress');
    expect(find.mock.calls[0][0]).toMatchObject({ status: { $in: ['Assigned', 'Accepted', 'Picked Up', 'In-Transit'] } });

    find.mockReturnValue(query([]) as any);
    jest.spyOn(DriverPayout, 'countDocuments').mockResolvedValue(2 as never);
    expect(await accountDeletionBlocker({ _id: USER_ID, role: 'driver' })).toContain('payout');
  });

  it("checks the customer's shipments, including staff quotes sent to their email", async () => {
    const quotes = jest.spyOn(Quote, 'find').mockReturnValue(query([{ _id: '64b0000000000000000000a1', vehicleName: '2020 Honda Civic' }]) as any);
    jest.spyOn(Load, 'find').mockReturnValue(query([{ quoteId: '64b0000000000000000000a1' }]) as any);
    expect(await accountDeletionBlocker({ _id: USER_ID, role: 'customer', email: 'Maria@Example.com' })).toContain('Your 2020 Honda Civic is still being shipped');
    expect(JSON.stringify(quotes.mock.calls[0][0])).toContain('maria@example.com');

    jest.spyOn(Load, 'find').mockReturnValue(query([]) as any);
    expect(await accountDeletionBlocker({ _id: USER_ID, role: 'customer', email: 'maria@example.com' })).toBeNull();
  });

  it('refuses the deletion with that message', async () => {
    jest.spyOn(Load, 'find').mockReturnValue(query([{ loadNumber: 'LD-9' }]) as any);
    jest.spyOn(DriverPayout, 'countDocuments').mockResolvedValue(0 as never);
    await expect(deleteOwnAccount({ _id: USER_ID, role: 'driver' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
