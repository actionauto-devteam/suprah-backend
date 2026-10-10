import { describeSmsFailure } from '../../src/utils/smsFailure';

describe('describeSmsFailure', () => {
  it('returns null for an empty or undefined errorDetail', () => {
    expect(describeSmsFailure(undefined)).toBeNull();
    expect(describeSmsFailure(null)).toBeNull();
    expect(describeSmsFailure('')).toBeNull();
  });

  it('maps a known Telnyx error code from a JSON error array', () => {
    const raw = JSON.stringify([{ code: '40003', title: 'Destination not SMS capable' }]);
    const result = describeSmsFailure(raw);
    expect(result?.category).toBe('landline');
    expect(result?.friendlyMessage).toMatch(/landline/i);
  });

  it('falls back to keyword classification when the JSON error is unrecognized', () => {
    const raw = JSON.stringify([{ code: '99999', title: 'Invalid destination number' }]);
    const result = describeSmsFailure(raw);
    expect(result?.category).toBe('invalid_number');
  });

  it('falls back to keyword classification when the string is not JSON at all', () => {
    const raw = 'Error: number is a landline and cannot receive SMS';
    const result = describeSmsFailure(raw);
    expect(result?.category).toBe('landline');
  });

  it('returns a generic unknown-category message when nothing matches', () => {
    const result = describeSmsFailure('some unrelated provider hiccup');
    expect(result?.category).toBe('unknown');
    expect(result?.friendlyMessage).toBeTruthy();
  });

  it('never throws on garbage input', () => {
    expect(() => describeSmsFailure('{not valid json')).not.toThrow();
    expect(() => describeSmsFailure('[]')).not.toThrow();
    expect(() => describeSmsFailure('{}')).not.toThrow();
  });
});
