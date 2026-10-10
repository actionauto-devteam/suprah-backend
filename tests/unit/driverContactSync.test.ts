const mockUserUpdateOne = jest.fn();
const mockProfileUpdateOne = jest.fn();
const mockWarn = jest.fn();

jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { updateOne: mockUserUpdateOne },
}));
jest.mock('../../src/models/DriverProfile.model', () => ({
  __esModule: true,
  default: { updateOne: mockProfileUpdateOne },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: mockWarn, info: jest.fn() },
}));

import {
  syncAccountPhoneToVerification,
  syncVerificationContactToAccount,
  usPhoneDigits,
} from '../../src/services/driverContactSync.service';

// The driver's phone lives on the account (Profile page) and on the
// verification record (Driver Verification form, which Dispatch reads first).
beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue({});
  mockProfileUpdateOne.mockResolvedValue({});
});

describe('usPhoneDigits', () => {
  it('turns a typed US phone into the 10 digits the Profile page stores', () => {
    expect(usPhoneDigits('(555) 123-4567')).toBe('5551234567');
    expect(usPhoneDigits('+1 555 123 4567')).toBe('5551234567');
    expect(usPhoneDigits('5551234567')).toBe('5551234567');
  });

  it('gives null for anything that is not a full US number', () => {
    expect(usPhoneDigits('')).toBeNull();
    expect(usPhoneDigits(undefined)).toBeNull();
    expect(usPhoneDigits('12345')).toBeNull();
    expect(usPhoneDigits('+44 20 7946 0958')).toBeNull();
  });
});

describe('syncVerificationContactToAccount (Driver Verification form saved)', () => {
  it('copies a changed phone to the account', async () => {
    await syncVerificationContactToAccount({
      userId: 'driver-1',
      previous: { phone: '(555) 000-0000', city: 'Denver', state: 'CO' },
      current: { phone: '(555) 123-4567', city: 'Denver', state: 'CO' },
    });
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: 'driver-1', role: 'driver' },
      { $set: { 'personalInfo.phone': '5551234567', 'personalInfo.phoneCountryCode': '+1' } },
    );
  });

  it('copies a changed city/state as the Profile page location', async () => {
    await syncVerificationContactToAccount({
      userId: 'driver-1',
      previous: { phone: '5551234567', city: 'Denver', state: 'CO' },
      current: { phone: '5551234567', city: 'Boise', state: 'ID' },
    });
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: 'driver-1', role: 'driver' },
      { $set: { 'personalInfo.location': 'Boise, ID' } },
    );
  });

  it('does nothing when the form was saved without changing phone or address', async () => {
    await syncVerificationContactToAccount({
      userId: 'driver-1',
      previous: { phone: '555-123-4567', city: 'Denver', state: 'CO' },
      current: { phone: '(555) 123-4567', city: 'Denver', state: 'CO' },
    });
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it("doesn't copy a phone that isn't a full US number", async () => {
    await syncVerificationContactToAccount({
      userId: 'driver-1',
      previous: { phone: '5551234567' },
      current: { phone: '12345' },
    });
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
  });

  it("keeps the verification save successful if the copy fails", async () => {
    mockUserUpdateOne.mockRejectedValueOnce(new Error('db down'));
    await expect(
      syncVerificationContactToAccount({
        userId: 'driver-1',
        previous: { phone: '5550000000' },
        current: { phone: '5551234567' },
      }),
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('syncAccountPhoneToVerification (Profile page saved)', () => {
  it('copies a changed phone to the verification record that Dispatch reads', async () => {
    await syncAccountPhoneToVerification({
      userId: 'driver-1',
      previousPhone: '5550000000',
      newPhone: '5551234567',
      countryCode: '+1',
    });
    expect(mockProfileUpdateOne).toHaveBeenCalledWith({ userId: 'driver-1' }, { $set: { phone: '5551234567' } });
  });

  it("doesn't push the account's number over the verification one when the phone wasn't changed", async () => {
    await syncAccountPhoneToVerification({
      userId: 'driver-1',
      previousPhone: '5551234567',
      newPhone: '5551234567',
      countryCode: '+1',
    });
    expect(mockProfileUpdateOne).not.toHaveBeenCalled();
  });

  it("doesn't clear the verification phone when the Profile page phone is emptied", async () => {
    await syncAccountPhoneToVerification({ userId: 'driver-1', previousPhone: '5551234567', newPhone: '', countryCode: '+1' });
    expect(mockProfileUpdateOne).not.toHaveBeenCalled();
  });

  it('treats no country code as US', async () => {
    await syncAccountPhoneToVerification({ userId: 'driver-1', previousPhone: '', newPhone: '5551234567', countryCode: '' });
    expect(mockProfileUpdateOne).toHaveBeenCalledWith({ userId: 'driver-1' }, { $set: { phone: '5551234567' } });
  });

  it("doesn't copy a number with another country code, which Dispatch would read as a US number", async () => {
    await syncAccountPhoneToVerification({ userId: 'driver-1', previousPhone: '', newPhone: '9171234567', countryCode: '+63' });
    expect(mockProfileUpdateOne).not.toHaveBeenCalled();
  });

  it('ignores a phone that is not plain text', async () => {
    await syncAccountPhoneToVerification({ userId: 'driver-1', previousPhone: '', newPhone: { $gt: '' }, countryCode: '+1' });
    expect(mockProfileUpdateOne).not.toHaveBeenCalled();
  });
});
