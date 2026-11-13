/**
 * Loads made from a quote show the quote's photo when the car isn't in the
 * dealership's inventory (2026-11-13).
 */
import { applyQuotePhotos, quoteIdsNeedingPhotos } from '../../src/utils/loadQuotePhoto';

const QUOTE = '64b0000000000000000000c1';
const OTHER_QUOTE = '64b0000000000000000000c2';
const CAR = '64b0000000000000000000a1';
const PHOTO = 'https://photos.example.test/camry.jpg';

describe('quoteIdsNeedingPhotos', () => {
  it('lists quotes of loads with a vehicle still missing a photo, once each', () => {
    expect(quoteIdsNeedingPhotos([
      { quoteId: QUOTE, vehicles: [{ vin: 'A' }] },
      { quoteId: { _id: QUOTE }, vehicles: [{ vin: 'A' }] },
      { quoteId: OTHER_QUOTE, vehicles: [{ vin: 'B', imageUrl: 'inventory.jpg' }] },
      { vehicles: [{ vin: 'C' }] },
      { quoteId: null, vehicles: [] },
    ])).toEqual([QUOTE]);
  });
});

describe('applyQuotePhotos', () => {
  it("gives a converted load's only vehicle the quote's photo", () => {
    const load = { quoteId: QUOTE, vehicles: [{ year: 2021, make: 'Toyota', model: 'Camry' }] };
    applyQuotePhotos([load], new Map([[QUOTE, { vehicleImage: PHOTO }]]));
    expect(load.vehicles[0]).toMatchObject({ imageUrl: PHOTO });
  });

  it('keeps an inventory photo already attached', () => {
    const load = { quoteId: QUOTE, vehicles: [{ vin: 'A', imageUrl: 'inventory.jpg' }] };
    applyQuotePhotos([load], new Map([[QUOTE, { vehicleImage: PHOTO }]]));
    expect(load.vehicles[0].imageUrl).toBe('inventory.jpg');
  });

  it('on a load with several cars, only the quote car (same VIN or inventory car) gets it', () => {
    const load = {
      quoteId: { _id: QUOTE },
      vehicles: [{ vin: '1hgcm82633a004352' }, { vin: 'OTHERVIN' }, { vehicleId: CAR }],
    };
    applyQuotePhotos([load], new Map([[QUOTE, { vehicleImage: PHOTO, vin: '1HGCM82633A004352' }]]));
    expect(load.vehicles.map((v: Record<string, unknown>) => v.imageUrl)).toEqual([PHOTO, undefined, undefined]);

    const byCar = { quoteId: QUOTE, vehicles: [{ vin: 'X' }, { vehicleId: CAR }] };
    applyQuotePhotos([byCar], new Map([[QUOTE, { vehicleImage: PHOTO, vehicleId: CAR }]]));
    expect(byCar.vehicles.map((v: Record<string, unknown>) => v.imageUrl)).toEqual([undefined, PHOTO]);
  });

  it('leaves loads alone when their quote has no photo or is not this dealership\'s', () => {
    const noPhoto = { quoteId: QUOTE, vehicles: [{ vin: 'A' }] };
    const elsewhere = { quoteId: OTHER_QUOTE, vehicles: [{ vin: 'A' }] };
    applyQuotePhotos([noPhoto, elsewhere], new Map([[QUOTE, { vehicleImage: '  ' }]]));
    expect(noPhoto.vehicles[0]).not.toHaveProperty('imageUrl');
    expect(elsewhere.vehicles[0]).not.toHaveProperty('imageUrl');
  });
});
