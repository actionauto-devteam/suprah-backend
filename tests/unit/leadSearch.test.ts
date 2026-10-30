import { buildLeadSearchCondition } from '../../src/utils/leadSearch';

const fieldsOf = (group: any) => group.$or.map((entry: any) => Object.keys(entry)[0]);

describe('Lead Inbox search', () => {
  it('returns nothing for empty input', () => {
    expect(buildLeadSearchCondition('')).toBeNull();
    expect(buildLeadSearchCondition('   ')).toBeNull();
    expect(buildLeadSearchCondition(undefined)).toBeNull();
  });

  it('needs every word to match, so a full name can span first and last name', () => {
    const condition: any = buildLeadSearchCondition('Kiran Pasupuleti');
    expect(condition.$and).toHaveLength(2);
    expect(fieldsOf(condition.$and[0])).toEqual(expect.arrayContaining(['firstName', 'lastName', 'email']));
    expect(condition.$and[1].$or[0].firstName.$regex).toBe('Pasupuleti');
  });

  it('searches vehicle year, make, model, VIN and stock', () => {
    const condition: any = buildLeadSearchCondition('2022 Honda CR-V');
    expect(condition.$and).toHaveLength(3);
    expect(fieldsOf(condition.$and[0])).toEqual(expect.arrayContaining(['vehicle.year', 'vehicle.make', 'vehicle.model', 'vehicle.vin', 'vehicle.stock']));
  });

  it('treats phone-shaped text as a phone search however the number is typed', () => {
    const shown: any = buildLeadSearchCondition('(801) 201-3320');
    expect(shown.$or[0]).toEqual({ normalizedPhone: { $regex: '8012013320' } });
    expect(new RegExp(shown.$or[1].phone.$regex).test('801-201-3320')).toBe(true);
    expect(new RegExp(shown.$or[1].phone.$regex).test('(801) 201-3320')).toBe(true);
    const withCountry: any = buildLeadSearchCondition('+1 801 201 3320');
    expect(withCountry.$or[0]).toEqual({ normalizedPhone: { $regex: '8012013320' } });
  });

  it('still matches a short number against other fields, such as a model year', () => {
    const condition: any = buildLeadSearchCondition('2022');
    expect(fieldsOf(condition)).toEqual(expect.arrayContaining(['normalizedPhone', 'phone', 'vehicle.year', 'vehicle.stock']));
  });

  it('handles hidden characters and long dashes in pasted text', () => {
    expect(buildLeadSearchCondition('\u202A801\u2013201\u20133320\u202C')).toEqual(buildLeadSearchCondition('801-201-3320'));
  });

  it('escapes regex characters so input cannot change the query', () => {
    const condition: any = buildLeadSearchCondition('(.*)');
    expect(condition.$and[0].$or[0].firstName.$regex).toBe('\\(\\.\\*\\)');
  });

  it('matches short words only at the start of a word when several words are typed', () => {
    const condition: any = buildLeadSearchCondition('Lead 1');
    const pattern = new RegExp(condition.$and[1].$or[0].firstName.$regex, 'i');
    expect(pattern.test('Lead 1')).toBe(true);
    expect(pattern.test('Lead 12')).toBe(true);
    expect(pattern.test('Lead 51')).toBe(false);
    const single: any = buildLeadSearchCondition('ip');
    expect(single.$and[0].$or[0].firstName.$regex).toBe('ip');
  });

  it('caps the search at 6 words', () => {
    const condition: any = buildLeadSearchCondition('a b c d e f g h');
    expect(condition.$and).toHaveLength(6);
  });
});
