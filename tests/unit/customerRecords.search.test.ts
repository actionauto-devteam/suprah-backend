jest.mock('../../src/services/customer.service', () => ({ __esModule: true, default: {} }));

import { buildCustomerSearch } from '../../src/services/customerRecords.service';

describe('buildCustomerSearch', () => {
  it('returns no filter for empty input', () => {
    expect(buildCustomerSearch('')).toBeNull();
    expect(buildCustomerSearch('   ')).toBeNull();
    expect(buildCustomerSearch(undefined)).toBeNull();
  });

  it('searches the normalized email when the text has an @', () => {
    expect(buildCustomerSearch('Jordan@Example.com')).toEqual({ normalizedEmail: { $regex: 'jordan@example\\.com' } });
  });

  it('treats phone-shaped text as a phone search on normalized numbers', () => {
    expect(buildCustomerSearch('(801) 555-0171')).toEqual({
      $or: [{ normalizedPhone: { $regex: '8015550171' } }, { normalizedAlternatePhone: { $regex: '8015550171' } }],
    });
  });

  it('still finds a pasted number with hidden characters or long dashes', () => {
    const expected = buildCustomerSearch('8012013320');
    expect(buildCustomerSearch('\u202A(801) 201-3320\u202C')).toEqual(expected);
    expect(buildCustomerSearch('801\u2013201\u20133320')).toEqual(expected);
  });

  it('does not treat short or mixed text as a phone search', () => {
    const short = buildCustomerSearch('555') as any;
    const mixed = buildCustomerSearch('Jordan 2022') as any;
    expect(short.$and).toHaveLength(1);
    expect(mixed.$and).toHaveLength(2);
  });

  it('matches every word against first name, last name or email', () => {
    const filter = buildCustomerSearch('Jordan Sample') as any;
    expect(filter.$and).toHaveLength(2);
    const first = filter.$and[0].$or;
    expect(first[0].firstName.test('jordan')).toBe(true);
    expect(first[1].lastName.test('JORDAN')).toBe(true);
    expect(first[2]).toEqual({ normalizedEmail: { $regex: 'jordan' } });
  });

  it('escapes regex characters so input cannot change the query', () => {
    const filter = buildCustomerSearch('(.*)[') as any;
    const pattern: RegExp = filter.$and[0].$or[0].firstName;
    expect(pattern.source).toBe('\\(\\.\\*\\)\\[');
    expect(pattern.test('anything')).toBe(false);
  });

  it('caps the search at 80 characters and 4 words', () => {
    const filter = buildCustomerSearch('a b c d e f g') as any;
    expect(filter.$and).toHaveLength(4);
    const long = buildCustomerSearch('x'.repeat(200)) as any;
    expect(long.$and[0].$or[0].firstName.source.length).toBe(80);
  });
});
