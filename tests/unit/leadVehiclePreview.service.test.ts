import {
  availabilityOf,
  normalizeStock,
  normalizeVin,
  requestedKey,
  requestedLabel,
  requestedVehicleFrom,
  summarizeVehicle,
} from '../../src/services/leadVehiclePreview.service';

describe('vehicle preview helpers', () => {
  it('normalizes VINs and rejects values that cannot be a VIN', () => {
    expect(normalizeVin(' 1hgcm82633a004352 ')).toBe('1HGCM82633A004352');
    expect(normalizeVin('1HG-CM8 2633A004352')).toBe('1HGCM82633A004352');
    expect(normalizeVin('N/A')).toBe('');
    expect(normalizeVin('1HGCM82633A00435O')).toBe('');
    expect(normalizeVin(undefined)).toBe('');
  });

  it('cleans stock numbers', () => {
    expect(normalizeStock('  T 200 ')).toBe('T 200');
    expect(normalizeStock(null)).toBe('');
  });

  it('keeps only real requested details and builds a stable key', () => {
    const requested = requestedVehicleFrom({ year: '2021', make: ' Toyota ', model: 'Tacoma', vin: 'bad', stock: '', trim: 'SR5' });
    expect(requested).toEqual({ year: '2021', make: 'Toyota', model: 'Tacoma', trim: 'SR5' });
    expect(requestedLabel(requested)).toBe('2021 Toyota Tacoma SR5');
    expect(requestedKey(requested)).toBe('ymm:2021|toyota|tacoma');
    expect(requestedKey({ ...requested, stock: 'T200' })).toBe('stock:t200');
    expect(requestedKey({ ...requested, vin: '1HGCM82633A004352' })).toBe('vin:1HGCM82633A004352');
    expect(requestedKey({})).toBe('');
    expect(requestedVehicleFrom({ year: 'abcd' }).year).toBeUndefined();
  });

  it('maps inventory status to availability without promising anything', () => {
    expect(availabilityOf({ status: 'Ready for Sale' })).toBe('listed');
    expect(availabilityOf({ status: 'In Recon' })).toBe('recon');
    expect(availabilityOf({ status: 'In Transit' })).toBe('in_transit');
    expect(availabilityOf({ status: 'Sold' })).toBe('sold');
    expect(availabilityOf({ status: 'Ready for Sale', isArchived: true })).toBe('archived');
    expect(availabilityOf({})).toBe('unknown');
  });

  it('only returns trusted fields and never invents missing ones', () => {
    const summary = summarizeVehicle({
      _id: 'v1', year: 2021, make: 'Toyota', modelName: 'Tacoma', vin: '3TMCZ5AN1MM000001',
      images: ['/local/path.jpg', 'https://img.example.com/1.jpg'], price: 0, mileage: 0, status: 'Ready for Sale', cost: 18000, notes: [{ text: 'internal' }],
    });
    expect(summary.photoUrl).toBe('https://img.example.com/1.jpg');
    expect(summary.price).toBeNull();
    expect(summary.mileage).toBeNull();
    expect(summary.stockNumber).toBeNull();
    expect(summary.exteriorColor).toBeNull();
    expect(summary.inventoryPath).toBe('/inventory?search=3TMCZ5AN1MM000001');
    expect(Object.keys(summary)).not.toEqual(expect.arrayContaining(['cost', 'notes']));
    const archived = summarizeVehicle({ _id: 'v2', vin: 'ABC', isArchived: true, archivedAt: new Date('2026-10-01T00:00:00Z'), images: [] });
    expect(archived.photoUrl).toBeNull();
    expect(archived.availability).toBe('archived');
    expect(archived.inventoryPath).toBe('/inventory?search=ABC&view=archived');
  });
});
