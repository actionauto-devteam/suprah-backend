import { otherIdentityShiftMessage } from '../../src/utils/crossIdentityShift.util';

describe('otherIdentityShiftMessage', () => {
  it('shows Mountain Standard Time in winter', () => {
    expect(otherIdentityShiftMessage(new Date('2026-11-16T16:50:46Z'))).toBe(
      "You're already clocked in on your other TimeProof account (since 9:50 AM MST) — please clock out there first before starting a new shift here.",
    );
  });

  it('shows Mountain Daylight Time in summer', () => {
    expect(otherIdentityShiftMessage(new Date('2026-07-15T15:50:00Z'))).toContain('(since 9:50 AM MDT)');
  });

  it('keeps the wording the Timeproof Clock page looks for', () => {
    expect(otherIdentityShiftMessage(new Date())).toMatch(/other TimeProof account/i);
  });
});
