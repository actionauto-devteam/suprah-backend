import { wishlistEntries } from '../../src/utils/wishlist';

const car = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: { toString: () => id },
  status: 'Ready for Sale',
  year: 2021,
  make: 'Toyota',
  modelName: 'Camry',
  trim: 'SE',
  images: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
  cost: 18000,
  leadCount: 7,
  price: 24000,
  ...extra,
});

// Stands in for Shop's customer format (member price, no cost or lead count).
const shopFormat = (vehicle: any) => ({ id: 'from-format', price: vehicle.price, memberPrice: vehicle.price - 500 });

describe('wishlistEntries', () => {
  it("cars for sale look like Shop's cars and keep the order they were saved in", () => {
    const entries = wishlistEntries(['b', 'a'], [car('a'), car('b')], shopFormat);
    expect(entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(entries[0]).toEqual({ id: 'b', price: 24000, memberPrice: 23500, available: true });
    expect(entries[0]).not.toHaveProperty('cost');
    expect(entries[0]).not.toHaveProperty('leadCount');
  });

  it('a car no longer for sale is listed so it can be removed, without its price or internal numbers', () => {
    const entries = wishlistEntries(
      ['sold', 'archived', 'deleted', 'recon'],
      [
        car('sold', { status: 'Sold' }),
        car('archived', { isArchived: true }),
        car('deleted', { isDeleted: true }),
        car('recon', { status: 'In Recon' }),
      ],
      shopFormat,
    );
    expect(entries.every((entry) => entry.available === false)).toBe(true);
    expect(entries[0]).toEqual({
      id: 'sold',
      year: 2021,
      make: 'Toyota',
      model: 'Camry',
      modelName: 'Camry',
      trim: 'SE',
      image: 'https://img.example.com/1.jpg',
      images: ['https://img.example.com/1.jpg'],
      available: false,
    });
    for (const entry of entries) {
      expect(entry).not.toHaveProperty('price');
      expect(entry).not.toHaveProperty('cost');
      expect(entry).not.toHaveProperty('leadCount');
    }
  });

  it('a saved car whose record is gone is left out', () => {
    expect(wishlistEntries(['gone', 'a'], [car('a')], shopFormat).map((entry) => entry.id)).toEqual(['a']);
    expect(wishlistEntries([], [], shopFormat)).toEqual([]);
  });
});
