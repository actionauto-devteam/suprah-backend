import {
  resolveSmsDestination,
  assertSmsDestination,
  isSmsDestinationError,
  SmsDestinationError,
  SMS_DESTINATION_MESSAGES,
  SMS_INVALID_DESTINATION_CODE,
  AUTOMATED_SMS_COUNTRIES,
} from '../../src/utils/smsDestination';
import { ApiError } from '../../src/utils/ApiError';
import { generateDemoPhone } from '../../src/utils/demoPhone';

function legacyNormalizePhone(raw: string): string {
  const digits = (raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  const only = digits.replace(/\D/g, '');
  if (only.length === 10) return `+1${only}`;
  if (only.length === 11 && only.startsWith('1')) return `+${only}`;
  return `+${only}`;
}

describe('resolveSmsDestination', () => {
  it.each([
    ['(385) 503-5869', '+13855035869', 'US'],
    ['385-503-5869', '+13855035869', 'US'],
    ['385.503.5869', '+13855035869', 'US'],
    ['3855035869', '+13855035869', 'US'],
    ['1-385-503-5869', '+13855035869', 'US'],
    ['13855035869', '+13855035869', 'US'],
    [' +1 (385) 503-5869 ', '+13855035869', 'US'],
    ['+14165550123', '+14165550123', 'CA'],
    ['604-555-1234', '+16045551234', 'CA'],
    ['+1 800 555 1234', '+18005551234', 'US'],
  ])('accepts the US/Canada number %p for automated and manual texts', (phone, e164, country) => {
    expect(resolveSmsDestination(phone, 'automated')).toEqual({ ok: true, e164, country });
    expect(resolveSmsDestination(phone, 'manual')).toEqual({ ok: true, e164, country });
  });

  it.each([
    ['+63 917 123 4567', '+639171234567', 'PH'],
    ['+639171234567', '+639171234567', 'PH'],
    ['+44 20 7946 0958', '+442079460958', 'GB'],
    ['+61 412 345 678', '+61412345678', 'AU'],
  ])('allows the international number %p only for manual texts', (phone, e164, country) => {
    expect(resolveSmsDestination(phone, 'manual')).toEqual({ ok: true, e164, country });
    expect(resolveSmsDestination(phone, 'automated')).toEqual({
      ok: false,
      reason: 'country_not_allowed',
      message: SMS_DESTINATION_MESSAGES.country_not_allowed,
    });
  });

  it.each([
    ['+1 787 200 1234', 'PR'],
    ['939-200-1234', 'PR'],
    ['(340) 773-1234', 'VI'],
    ['+1 671 477 1234', 'GU'],
    ['+1 684 733 1234', 'AS'],
    ['+1 670 234 1234', 'MP'],
  ])('allows automated texts to the US territory number %p', (phone, country) => {
    expect(resolveSmsDestination(phone, 'automated')).toMatchObject({ ok: true, country });
    expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: true, country });
  });

  it.each([
    ['+1 876 555 1234', 'JM'],
    ['+1 809 555 0123', 'DO'],
    ['+1 242 357 1234', 'BS'],
    ['+1 246 230 1234', 'BB'],
    ['+1 868 220 1234', 'TT'],
    ['+1 441 295 1234', 'BM'],
    ['+1 345 949 1234', 'KY'],
    ['+1 284 540 1234', 'VG'],
  ])('blocks automated texts to the +1 number %p outside the US, its territories and Canada', (phone, country) => {
    expect(resolveSmsDestination(phone, 'automated')).toMatchObject({ ok: false, reason: 'country_not_allowed' });
    expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: true, country });
  });

  it('lists exactly the approved automated destinations', () => {
    expect([...AUTOMATED_SMS_COUNTRIES].sort()).toEqual(['AS', 'CA', 'GU', 'MP', 'PR', 'US', 'VI']);
  });

  it('still blocks extensions and malformed territory numbers', () => {
    expect(resolveSmsDestination('787-200-1234 x5', 'automated')).toMatchObject({ ok: false, reason: 'extension' });
    expect(resolveSmsDestination('+1 787 200', 'automated')).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  it('blocks a premium-rate number for every kind of text', () => {
    expect(resolveSmsDestination('+1 900 555 1234', 'manual')).toMatchObject({ ok: false, reason: 'unsupported_number_type' });
    expect(resolveSmsDestination('+1 900 555 1234', 'automated')).toMatchObject({ ok: false, reason: 'unsupported_number_type' });
  });

  it.each([
    '385-503-5869 x12',
    '385-503-5869 ext 12',
    '(385) 503-5869 ext. 1234',
    '385-503-5869 extension 5',
    '3855035869x12',
    '385-503-5869 #12',
    '385-503-5869;ext=12',
    '+1 385 503 5869 ext12',
  ])('blocks the extension in %p without stripping it', (phone) => {
    expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'extension' });
    expect(resolveSmsDestination(phone, 'automated')).toMatchObject({ ok: false, reason: 'extension' });
  });

  it.each(['call 385-503-5869', '385+503-5869', '(+1) 385 503 5869', '385-503-5869, 12'])(
    'blocks unsupported characters in %p',
    (phone) => {
      expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'unsupported_characters' });
    },
  );

  it.each(['+999 123 456 789', '+0 385 503 5869'])('blocks the invalid country code in %p', (phone) => {
    expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it.each(['503-5869', '555-12', '+12345', '+1 385 503'])('blocks the short or incomplete number %p', (phone) => {
    expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  it.each(['23855035869', '385503586912', '+44 (0) 20 7946 0958'])(
    'blocks the ambiguous number %p instead of guessing',
    (phone) => {
      expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'ambiguous' });
    },
  );

  it.each(['+385503586912', '+180170268', '+1234567890123456'])(
    'blocks the legacy malformed stored number %p for every kind of text',
    (phone) => {
      expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'invalid' });
      expect(resolveSmsDestination(phone, 'automated')).toMatchObject({ ok: false, reason: 'invalid' });
    },
  );

  it.each(['', '   ', null, undefined])('treats %p as a missing number', (phone) => {
    expect(resolveSmsDestination(phone, 'manual')).toMatchObject({ ok: false, reason: 'missing' });
  });

  it.each(['+18015550100', '801-555-0142', '(212) 555-0199', generateDemoPhone()])(
    'accepts the Demo Lab number %p for automated texts',
    (phone) => {
      expect(resolveSmsDestination(phone, 'automated')).toMatchObject({ ok: true, country: 'US' });
    },
  );

  it.each([
    '(385) 503-5869',
    '13855035869',
    '+1 385 503 5869',
    '+14165550123',
    '+63 917 123 4567',
    '+44 20 7946 0958',
    '+18015550142',
  ])('returns the same key the conversation and opt-out lookups already use for %p', (phone) => {
    const result = resolveSmsDestination(phone, 'manual');
    expect(result.ok).toBe(true);
    expect(result.ok && result.e164).toBe(legacyNormalizePhone(phone));
  });
});

describe('SmsDestinationError', () => {
  it('is a 400 ApiError with a structured reason for the API response', () => {
    const err = new SmsDestinationError('country_not_allowed', 'automated');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(SMS_DESTINATION_MESSAGES.country_not_allowed);
    expect(err.errors).toEqual([{ code: SMS_INVALID_DESTINATION_CODE, reason: 'country_not_allowed', policy: 'automated' }]);
    expect(isSmsDestinationError(err)).toBe(true);
    expect(isSmsDestinationError(new Error('other'))).toBe(false);
  });

  it('assertSmsDestination returns the E.164 number or throws the structured error', () => {
    expect(assertSmsDestination('(385) 503-5869', 'automated')).toBe('+13855035869');
    expect(() => assertSmsDestination('+639171234567', 'automated')).toThrow(SmsDestinationError);
    try {
      assertSmsDestination('385-503-5869 x12', 'manual');
    } catch (err: any) {
      expect(err.reason).toBe('extension');
      expect(err.policy).toBe('manual');
    }
  });
});
