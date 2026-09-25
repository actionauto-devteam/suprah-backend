import { businessDateCompactKey } from '../../src/utils/businessDate';

describe('businessDateCompactKey (America/Denver)', () => {
  it('uses the Denver calendar day, not UTC, late in the evening (MDT)', () => {
    // 2026-09-05 04:30 UTC is 2026-09-04 22:30 MDT (UTC-6).
    expect(businessDateCompactKey(new Date('2026-09-05T04:30:00Z'))).toBe('20260904');
    expect(businessDateCompactKey(new Date('2026-09-05T06:00:00Z'))).toBe('20260905');
  });

  it('uses the Denver calendar day in winter (MST)', () => {
    // 2026-01-15 06:59 UTC is 2026-01-14 23:59 MST (UTC-7).
    expect(businessDateCompactKey(new Date('2026-01-15T06:59:00Z'))).toBe('20260114');
    expect(businessDateCompactKey(new Date('2026-01-15T07:00:00Z'))).toBe('20260115');
  });

  it('handles the DST change days', () => {
    // Spring forward 2026-03-08, fall back 2026-11-01.
    expect(businessDateCompactKey(new Date('2026-03-08T12:00:00Z'))).toBe('20260308');
    expect(businessDateCompactKey(new Date('2026-11-02T06:30:00Z'))).toBe('20261101');
  });
});
