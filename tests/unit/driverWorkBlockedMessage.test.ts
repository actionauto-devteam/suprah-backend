/**
 * When a driver can't accept or request a load, the server tells them why in
 * their own words (the same "Work Availability" their Driver Page uses) and
 * what they can do about it. Pure wording; no database is used.
 */
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { driverWorkBlockedMessage } from '../../src/services/driverStatusTransition.service';

describe('why a driver can’t take new work', () => {
  it('On Leave or In Shop: says where to switch back to Active', () => {
    expect(driverWorkBlockedMessage({ operationalStatus: 'on_leave' }, 'accept')).toBe(
      "Your Work Availability is On Leave, so you can't accept this load. Switch it to Active on your Driver Page, then try again.",
    );
    expect(driverWorkBlockedMessage({ operationalStatus: 'maintenance' }, 'request')).toBe(
      "Your Work Availability is In Shop, so you can't request new loads. Switch it to Active on your Driver Page when your truck is ready, then try again.",
    );
  });

  it('a request being handled: says what is happening and when it ends', () => {
    expect(driverWorkBlockedMessage({ operationalStatus: 'active', code: 'DRIVER_EMERGENCY_RELEASE_ACTIVE' }, 'accept')).toMatch(
      /^Your emergency release request is active, so you can't accept this load .* Message Dispatch in Messages/,
    );
    expect(driverWorkBlockedMessage({ operationalStatus: 'active', code: 'DRIVER_STATUS_CHANGE_COORDINATED' }, 'request')).toMatch(
      /coordinated with the Dispatch teams you work with, so you can't request new loads yet/,
    );
    expect(driverWorkBlockedMessage({ operationalStatus: 'active', code: 'DRIVER_STATUS_CHANGE_AWAITING_REASSIGNMENT' }, 'accept')).toMatch(
      /your loads are being handed to other drivers, so you can't accept this load yet/,
    );
  });

  it('anything else: where to look, then Suprah AI support', () => {
    const message = driverWorkBlockedMessage({ operationalStatus: 'active', code: null }, 'accept');
    expect(message).toMatch(/^You can't accept this load right now\. Check your Work Availability on your Driver Page/);
    expect(message).toMatch(/contact Suprah AI support at support@suprahai\.com\.$/);
  });

  it('never talks about the driver in the third person or says "Dispatch Status"', () => {
    const all = [
      { operationalStatus: 'on_leave' }, { operationalStatus: 'maintenance' },
      { code: 'DRIVER_EMERGENCY_RELEASE_ACTIVE' }, { code: 'DRIVER_STATUS_CHANGE_COORDINATED' },
      { code: 'DRIVER_STATUS_CHANGE_AWAITING_REASSIGNMENT' }, {},
    ].flatMap((eligibility) => (['accept', 'request'] as const).map((action) => driverWorkBlockedMessage(eligibility, action)));
    for (const message of all) {
      expect(message).not.toMatch(/This driver|Dispatch Status|Unable to/);
    }
  });
});
