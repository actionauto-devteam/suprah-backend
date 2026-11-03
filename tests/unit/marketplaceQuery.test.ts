/**
 * The customer marketplace's search, filters, sorting and paging: visitor
 * text is plain text (never a database pattern), partial words are found,
 * paging is capped and newest listings come first by default.
 */
import {
  MARKETPLACE_MAX_LIMIT,
  containsText,
  exactText,
  marketplacePaging,
  marketplaceSearchClause,
  marketplaceSort,
  queryNumber,
} from '../../src/services/marketplaceQuery';

describe('search', () => {
  it('finds part of a word in the make, model, trim, VIN or stock number', () => {
    const clause: any = marketplaceSearchClause('cam');
    const fields = clause.$and[0].$or.map((entry: Record<string, unknown>) => Object.keys(entry)[0]);
    expect(fields).toEqual(['make', 'modelName', 'trim', 'vin', 'stockNumber']);
    expect(clause.$and[0].$or[1].modelName.test('Camry')).toBe(true);
  });

  it('needs every word, and a four-digit word can be the year', () => {
    const clause: any = marketplaceSearchClause('  2021   toyota ');
    expect(clause.$and).toHaveLength(2);
    expect(clause.$and[0].$or).toContainEqual({ year: 2021 });
    expect(clause.$and[1].$or).not.toContainEqual(expect.objectContaining({ year: expect.anything() }));
  });

  it('treats symbols as plain text and ignores empty searches', () => {
    const clause: any = marketplaceSearchClause('(a+)+$');
    const pattern: RegExp = clause.$and[0].$or[0].make;
    expect(pattern.test('(a+)+$')).toBe(true);
    expect(pattern.test('aaaa')).toBe(false);
    expect(marketplaceSearchClause('   ')).toBeNull();
    expect(marketplaceSearchClause(undefined)).toBeNull();
  });

  it('uses at most six words', () => {
    expect((marketplaceSearchClause('a b c d e f g h') as any).$and).toHaveLength(6);
  });
});

describe('filters', () => {
  it('matches dropdown values exactly, ignoring case, as plain text', () => {
    expect(exactText('Toyota')!.test('TOYOTA')).toBe(true);
    expect(exactText('Toyota')!.test('Toyota Camry')).toBe(false);
    expect(exactText('.*')!.test('anything')).toBe(false);
    expect(exactText('')).toBeNull();
    expect(exactText(['Honda', 'x'])!.test('honda')).toBe(true);
  });

  it('matches free text as plain text', () => {
    expect(containsText('suv')!.test('Compact SUV')).toBe(true);
    expect(containsText('[')!.test('a[b')).toBe(true);
  });

  it('reads numbers safely', () => {
    expect(queryNumber('2020')).toBe(2020);
    expect(queryNumber('abc')).toBeUndefined();
    expect(queryNumber('')).toBeUndefined();
  });
});

describe('paging and sorting', () => {
  it('keeps the page and page size within safe bounds', () => {
    expect(marketplacePaging('2', '12')).toEqual({ pageNum: 2, limitNum: 12, skip: 12 });
    expect(marketplacePaging('abc', '100000')).toEqual({ pageNum: 1, limitNum: MARKETPLACE_MAX_LIMIT, skip: 0 });
    expect(marketplacePaging('-3', '0')).toEqual({ pageNum: 1, limitNum: 1, skip: 0 });
    expect(marketplacePaging(undefined, undefined)).toEqual({ pageNum: 1, limitNum: 20, skip: 0 });
  });

  it('shows the newest listings first by default', () => {
    expect(marketplaceSort(undefined, undefined)).toEqual({ key: 'recent', sort: { dateAdded: -1, _id: -1 } });
    expect(marketplaceSort('', '')).toEqual({ key: 'recent', sort: { dateAdded: -1, _id: -1 } });
  });

  it('follows the chosen sort, low to high when no direction is given', () => {
    expect(marketplaceSort('price', 'asc').sort).toEqual({ price: 1, _id: 1 });
    expect(marketplaceSort('year', 'desc').sort).toEqual({ year: -1, _id: -1 });
    expect(marketplaceSort('mileage', undefined).sort).toEqual({ mileage: 1, _id: 1 });
    expect(marketplaceSort('demand', 'desc').key).toBe('demand');
  });

  it("doesn't offer the dealership's low-performing sort", () => {
    expect(marketplaceSort('low-performing', 'desc')).toEqual({ key: 'recent', sort: { dateAdded: -1, _id: -1 } });
  });
});
