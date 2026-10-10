import {
  complianceExpiryItems,
  describeComplianceItems,
  isComplianceExpiredAt,
} from '../../src/models/DriverProfile.model';

// Which credentials expired or expire soon, named the way drivers and Dispatch read them.
describe('complianceExpiryItems / describeComplianceItems', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');

  it('names each credential with its day, and says whether it has expired', () => {
    const items = complianceExpiryItems(
      {
        licenseExpirationDate: new Date('2026-10-01T00:00:00Z'),
        medicalCardExpirationDate: new Date('2026-10-20T00:00:00Z'),
      },
      now,
    );
    expect(items).toEqual([
      { label: 'CDL', date: '2026-10-01', expired: true, daysLeft: -7 },
      { label: 'medical card', date: '2026-10-20', expired: false, daysLeft: 12 },
    ]);
  });

  it('writes the list as the warnings show it, without shifting the calendar day', () => {
    const items = complianceExpiryItems(
      { licenseExpirationDate: '2026-10-01', insuranceExpirationDate: '2026-09-28' },
      now,
    );
    expect(describeComplianceItems(items)).toBe('CDL (Oct 1, 2026), insurance (Sep 28, 2026)');
  });

  it('leaves out credentials without a usable date', () => {
    expect(complianceExpiryItems({ licenseExpirationDate: '', medicalCardExpirationDate: 'soon' }, now)).toEqual([]);
  });
});

// Whether a driver's CDL, medical card or insurance has expired, worked out
// from the dates (the stored flag can lag until the profile is saved again).
describe('isComplianceExpiredAt', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const past = new Date('2026-10-07T00:00:00Z');
  const future = new Date('2026-11-01T00:00:00Z');

  it('is not expired without a profile or without any dates', () => {
    expect(isComplianceExpiredAt(null, now)).toBe(false);
    expect(isComplianceExpiredAt(undefined, now)).toBe(false);
    expect(isComplianceExpiredAt({}, now)).toBe(false);
  });

  it('is not expired while every date is still ahead', () => {
    expect(
      isComplianceExpiredAt(
        { licenseExpirationDate: future, medicalCardExpirationDate: future, insuranceExpirationDate: future },
        now,
      ),
    ).toBe(false);
  });

  it.each(['licenseExpirationDate', 'medicalCardExpirationDate', 'insuranceExpirationDate'] as const)(
    'is expired once %s has passed, even though the others are fine',
    (field) => {
      const profile = {
        licenseExpirationDate: future,
        medicalCardExpirationDate: future,
        insuranceExpirationDate: future,
        [field]: past,
      };
      expect(isComplianceExpiredAt(profile, now)).toBe(true);
    },
  );

  it('accepts dates stored as text and ignores empty or unreadable values', () => {
    expect(isComplianceExpiredAt({ licenseExpirationDate: '2026-10-01' }, now)).toBe(true);
    expect(isComplianceExpiredAt({ licenseExpirationDate: '' }, now)).toBe(false);
    expect(isComplianceExpiredAt({ licenseExpirationDate: 'not a date' }, now)).toBe(false);
    expect(isComplianceExpiredAt({ licenseExpirationDate: null }, now)).toBe(false);
  });
});
