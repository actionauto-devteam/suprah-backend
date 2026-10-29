const mockFindAccountPhoneNumber = jest.fn();

jest.mock('../../src/services/telnyx.service', () => {
  class LocalUiAcceptanceModeBlockedError extends Error {}
  return {
    COMPANY_NUMBER: '+18015550900',
    MESSAGING_PROFILE_ID: '',
    LocalUiAcceptanceModeBlockedError,
    findAccountPhoneNumber: (...args: unknown[]) => mockFindAccountPhoneNumber(...args),
  };
});

import * as telnyx from '../../src/services/telnyx.service';
import {
  checkNumberInTelnyx,
  leadFieldsForLine,
  normalizeDealershipNumber,
  parsePhoneNumberInput,
  resetTelnyxReferenceCache,
} from '../../src/services/dealershipPhoneNumber.service';

describe('dealership phone numbers', () => {
  beforeEach(() => {
    mockFindAccountPhoneNumber.mockReset();
    resetTelnyxReferenceCache();
  });

  it('accepts common ways of writing a US number and rejects everything else', () => {
    expect(normalizeDealershipNumber('(801) 555-0910')).toBe('+18015550910');
    expect(normalizeDealershipNumber('801.555.0910')).toBe('+18015550910');
    expect(normalizeDealershipNumber('1-801-555-0910')).toBe('+18015550910');
    expect(normalizeDealershipNumber('+18015550910')).toBe('+18015550910');
    expect(normalizeDealershipNumber('555-12')).toBeNull();
    expect(normalizeDealershipNumber('+448015550910')).toBeNull();
    expect(normalizeDealershipNumber('(101) 555-0910')).toBeNull();
    expect(normalizeDealershipNumber(undefined)).toBeNull();
  });

  it('keeps only the field that matches the type of number', () => {
    expect(parsePhoneNumberInput({ number: '8015550900', kind: 'main', label: '', location: 'LEHI', department: 'Sales' }))
      .toEqual({ number: '+18015550900', label: 'Main', kind: 'main', location: '', department: '', ringGroupId: null });
    expect(parsePhoneNumberInput({ number: '8015550910', kind: 'location', label: ' Lehi   Sales ', location: 'LEHI', department: 'Sales' }))
      .toEqual({ number: '+18015550910', label: 'Lehi Sales', kind: 'location', location: 'LEHI', department: '', ringGroupId: null });
    expect(() => parsePhoneNumberInput({ number: '8015550910', kind: 'location', label: 'x'.repeat(61), location: 'LEHI' })).toThrow(/up to 60/);
  });

  it('tags new leads with the line, and with the location only for location numbers', () => {
    const base = { organizationId: 'org', number: '+18015550910', label: 'Lehi Sales', location: 'LEHI', department: '', ringGroupId: null };
    expect(leadFieldsForLine({ ...base, kind: 'location' })).toEqual({ dealershipLine: 'Lehi Sales', location: 'LEHI' });
    expect(leadFieldsForLine({ ...base, kind: 'department', label: 'Service', location: '' })).toEqual({ dealershipLine: 'Service' });
    expect(leadFieldsForLine(null)).toEqual({});
  });

  it('compares a number with the main Suprah number when no messaging profile is configured', async () => {
    mockFindAccountPhoneNumber.mockImplementation(async (number: string) => (number === '+18015550900'
      ? { status: 'active', connectionId: 'conn-1', messagingProfileId: 'mp-1' }
      : { status: 'active', connectionId: 'conn-1', messagingProfileId: 'mp-2' }));
    const result = await checkNumberInTelnyx('+18015550910');
    expect(result).toMatchObject({ status: 'needs_setup', readyForCalls: true, readyForTexts: false });
    expect(result.message).toMatch(/different messaging profile/);
  });

  it('reports a number that is not active in Telnyx', async () => {
    mockFindAccountPhoneNumber.mockResolvedValue({ status: 'port-pending', connectionId: 'conn-1', messagingProfileId: 'mp-1' });
    const result = await checkNumberInTelnyx('+18015550900');
    expect(result).toMatchObject({ status: 'needs_setup', readyForCalls: false, readyForTexts: false });
    expect(result.message).toMatch(/port-pending/);
  });

  it('does not call Telnyx on the local test system and says so', async () => {
    mockFindAccountPhoneNumber.mockRejectedValue(new (telnyx as any).LocalUiAcceptanceModeBlockedError('blocked'));
    expect(await checkNumberInTelnyx('+18015550910')).toMatchObject({ status: 'unchecked', message: 'Telnyx is not checked on this test system.' });
  });
});
