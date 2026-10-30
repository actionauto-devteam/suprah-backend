import { streetKey } from '../../src/services/licensePossibleMatch.service';

describe('license possible match street key', () => {
  it('uses the house number and street name from the first line', () => {
    expect(streetKey('123 MAIN ST, OREM, UT 84057')).toBe('123 main');
    expect(streetKey('123 Main Street\nOrem UT')).toBe('123 main');
  });

  it('keeps the direction so Utah grid addresses stay distinct', () => {
    expect(streetKey('1234 W 800 N, Lehi, UT')).toBe('1234 w 800');
    expect(streetKey('1234 E 800 N, Lehi, UT')).toBe('1234 e 800');
  });

  it('treats a spelled-out direction the same as its short letter', () => {
    expect(streetKey('1234 West 800 North')).toBe(streetKey('1234 W 800 N, Lehi'));
    expect(streetKey('77 Northeast Elm Ave')).toBe('77 ne elm');
  });

  it('returns nothing when there is no house number to compare', () => {
    expect(streetKey('PO Box 55, Orem')).toBe('');
    expect(streetKey('Orem, UT')).toBe('');
    expect(streetKey('')).toBe('');
    expect(streetKey(undefined)).toBe('');
  });

  it('ignores punctuation and letter suffixes on the house number', () => {
    expect(streetKey('12B. Oak-Lane Dr.')).toBe('12b oak');
  });
});
