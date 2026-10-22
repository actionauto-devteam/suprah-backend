import { INVALID_SMS_PHONE_MESSAGE, PHONE_EXTENSION_MESSAGE, manualSmsPhoneProblem } from '../../src/utils/manualSmsPhone';

describe('manualSmsPhoneProblem', () => {
  it.each([
    '(385) 503-5869',
    '385-503-5869',
    '385.503.5869',
    '385 503 5869',
    '3855035869',
    '1-385-503-5869',
    '13855035869',
    '+1 385 503 5869',
    '+13855035869',
    ' +1 (385) 503-5869 ',
    '+44 20 7946 0958',
  ])('accepts the supported format %p', (phone) => {
    expect(manualSmsPhoneProblem(phone)).toBeNull();
  });

  it.each([
    '385-503-5869 x12',
    '385-503-5869 ext 12',
    '(385) 503-5869 ext. 1234',
    '385-503-5869 #12',
    '385-503-5869;ext=12',
    '385-503-5869, 12',
    'call 385-503-5869',
    '385+503-5869',
    '(+1) 385 503 5869',
  ])('blocks the extension or unsupported characters in %p', (phone) => {
    expect(manualSmsPhoneProblem(phone)).toBe(PHONE_EXTENSION_MESSAGE);
  });

  it.each([
    '',
    '   ',
    '503-5869',
    '555-12',
    '23855035869',
    '385503586912',
    '+12345',
    '+1234567890123456',
  ])('blocks the unusable number %p', (phone) => {
    expect(manualSmsPhoneProblem(phone)).toBe(INVALID_SMS_PHONE_MESSAGE);
  });

  it('blocks missing values', () => {
    expect(manualSmsPhoneProblem(undefined)).toBe(INVALID_SMS_PHONE_MESSAGE);
    expect(manualSmsPhoneProblem(null)).toBe(INVALID_SMS_PHONE_MESSAGE);
  });
});
