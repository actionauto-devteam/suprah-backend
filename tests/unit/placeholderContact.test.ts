import {
  contactIdentity,
  isPlaceholderEmail,
  isPlaceholderPhone,
  matchableIdentityEmail,
  matchableIdentityPhone,
} from '../../src/utils/contactIdentity';

describe('placeholder contact details', () => {
  it('recognizes fake emails that lead sources or staff fill in', () => {
    for (const email of [
      'none@none.com',
      'NOEMAIL@gmail.com',
      'no-email@yahoo.com',
      'test@test.com',
      'na@dealer.com',
      'unknown@hotmail.com',
      'x@example.com',
      'customer@noemail.com',
      'someone@fake.com',
      'anything@site.invalid',
      'demo.customer@example.com',
    ]) {
      expect(isPlaceholderEmail(email)).toBe(true);
      expect(matchableIdentityEmail(email)).toBeNull();
    }
  });

  it('keeps real-looking emails', () => {
    for (const email of ['kiran.p@gmail.com', 'lisa@yahoo.com', 'pat@example.com', 'testdrive@outlook.com', 'nonelson@gmail.com']) {
      expect(isPlaceholderEmail(email)).toBe(false);
      expect(matchableIdentityEmail(email)).toBe(email);
    }
  });

  it('recognizes fake phone numbers', () => {
    for (const phone of ['888-888-8888', '(801) 555-5555', '303-777-7777']) {
      expect(isPlaceholderPhone(phone)).toBe(true);
      expect(matchableIdentityPhone(phone)).toBeNull();
    }
    for (const phone of ['801-000-0000', '801-123-4567', '000-000-0000']) {
      expect(matchableIdentityPhone(phone)).toBeNull();
    }
  });

  it('keeps real phone numbers, including the reserved demo range', () => {
    expect(matchableIdentityPhone('(385) 549-2734')).toBe('+13855492734');
    expect(matchableIdentityPhone('801-555-0101')).toBe('+18015550101');
    expect(matchableIdentityPhone('+1 801 555 1234')).toBe('+18015551234');
    expect(isPlaceholderPhone('not a phone')).toBe(false);
    expect(matchableIdentityPhone('')).toBeNull();
  });

  it('leaves fake details out of the stored identity used for matching', () => {
    expect(contactIdentity({ email: 'none@none.com', phone: '801-555-5555' })).toEqual({
      normalizedEmail: null,
      normalizedPhone: null,
      normalizedAlternatePhone: null,
    });
    expect(contactIdentity({ email: 'none@none.com', phone: '(385) 549-2734' })).toMatchObject({
      normalizedEmail: null,
      normalizedPhone: '+13855492734',
    });
  });
});
