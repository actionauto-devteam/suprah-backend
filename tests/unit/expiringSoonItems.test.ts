import {
  complianceExpiryCutoff,
  complianceExpiryItems,
  expiringSoonItems,
  isComplianceExpiredAt,
  mountainDaysUntil,
} from '../../src/models/DriverProfile.model';

const day = (key: string) => new Date(`${key}T00:00:00Z`);
// Oct 13, 2026 at 10:00 AM MDT.
const morning = Date.parse('2026-10-13T16:00:00Z');

describe('expiration days on the Mountain Time calendar', () => {
  // Oct 16 at 9:00 PM MDT, which is already Oct 17 in UTC.
  const evening = Date.parse('2026-10-17T03:00:00Z');

  it('counts whole Mountain Time days, 0 on the day itself', () => {
    expect(mountainDaysUntil(day('2026-10-17'), evening)).toBe(1);
    expect(mountainDaysUntil(day('2026-10-16'), evening)).toBe(0);
    expect(mountainDaysUntil(day('2026-10-10'), evening)).toBe(-6);
    expect(mountainDaysUntil(null, evening)).toBeNull();
  });

  it("doesn't call a credential expired the evening before its date (it used to at 6 PM)", () => {
    const profile = { licenseExpirationDate: day('2026-10-17') };
    expect(isComplianceExpiredAt(profile, evening)).toBe(false);
    expect(complianceExpiryItems(profile, evening)[0]).toMatchObject({ expired: false, daysLeft: 1 });
    // From midnight Mountain Time on Oct 17 it has expired.
    expect(isComplianceExpiredAt(profile, Date.parse('2026-10-17T06:00:00Z'))).toBe(true);
  });

  it('gives the database cutoff that matches: the start of tomorrow, as stored', () => {
    expect(complianceExpiryCutoff(evening).toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(complianceExpiryCutoff(Date.parse('2026-10-17T06:00:00Z')).toISOString()).toBe('2026-10-18T00:00:00.000Z');
  });
});

describe('expiringSoonItems (Driver Page "expires soon" notice)', () => {
  it('counts the days on the Mountain Time calendar, also late in the evening', () => {
    const profile = { licenseExpirationDate: day('2026-10-16') };
    expect(expiringSoonItems(profile, 30, morning)[0].daysLeft).toBe(3);
    // Oct 13 at 9:00 PM MDT is already Oct 14 in UTC; it's still Oct 13 in Denver.
    expect(expiringSoonItems(profile, 30, Date.parse('2026-10-14T03:00:00Z'))[0].daysLeft).toBe(3);
  });

  it('includes 30, 14 and 3 days out, but not the expiration day itself or later', () => {
    const at = (key: string) => expiringSoonItems({ medicalCardExpirationDate: day(key) }, 30, morning);
    expect(at('2026-11-12')[0].daysLeft).toBe(30);
    expect(at('2026-10-27')[0].daysLeft).toBe(14);
    expect(at('2026-10-14')[0].daysLeft).toBe(1);
    expect(at('2026-11-13')).toEqual([]);
    expect(at('2026-10-13')).toEqual([]);
    expect(at('2026-10-01')).toEqual([]);
  });

  it("uses an uploaded document's date even when the profile has a later one", () => {
    const items = expiringSoonItems(
      {
        licenseExpirationDate: day('2030-07-19'),
        documents: [{ type: 'drivers_license', label: 'CDL', expiresAt: day('2026-10-27'), reviewStatus: 'pending' }],
      },
      30,
      morning,
    );
    expect(items).toEqual([{ label: 'CDL', date: '2026-10-27', expired: false, daysLeft: 14 }]);
  });

  it('lets an uploaded renewal replace the old document, and ignores rejected ones', () => {
    expect(
      expiringSoonItems(
        {
          documents: [
            { type: 'drivers_license', expiresAt: day('2026-10-20'), reviewStatus: 'approved' },
            { type: 'drivers_license', expiresAt: day('2030-10-20'), reviewStatus: 'pending' },
            { type: 'medical_card', expiresAt: day('2031-01-01'), reviewStatus: 'rejected' },
            { type: 'medical_card', expiresAt: day('2026-10-18'), reviewStatus: 'approved' },
          ],
        },
        30,
        morning,
      ),
    ).toEqual([{ label: 'medical card', date: '2026-10-18', expired: false, daysLeft: 5 }]);
  });

  it('covers every dated document type, closest first', () => {
    const items = expiringSoonItems(
      {
        documents: [
          { type: 'vehicle_registration', expiresAt: day('2026-11-01'), reviewStatus: 'approved' },
          { type: 'dot_inspection', expiresAt: day('2026-10-20'), reviewStatus: 'pending' },
          { type: 'other', label: 'Hazmat Endorsement', expiresAt: day('2026-10-25'), reviewStatus: 'approved' },
        ],
      },
      30,
      morning,
    );
    expect(items.map((item) => [item.label, item.daysLeft])).toEqual([
      ['DOT inspection', 7],
      ['Hazmat Endorsement', 12],
      ['vehicle registration', 19],
    ]);
  });
});
