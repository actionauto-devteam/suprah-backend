import {
  buildInquiryContentKey,
  buildInquiryFingerprint,
  buildProviderInquiryKey,
  inquiryVehicleKey,
  normalizeProviderName,
  requestDateIdentity,
} from '../../src/utils/inquiryKeys';

const base = {
  provider: 'CarFax',
  email: 'Pat.Lee@Example.com',
  phone: '(385) 503-5869',
  vehicle: { year: '2022', make: 'Honda', model: 'Civic' },
  comments: 'Is it still available?',
};

describe('provider inquiry keys', () => {
  it('scopes the inquiry id by provider', () => {
    expect(buildProviderInquiryKey('CarFax', 'A-100')).toBe('carfax:A-100');
    expect(buildProviderInquiryKey('AutoTrader', 'A-100')).toBe('autotrader:A-100');
    expect(buildProviderInquiryKey('  Car  Fax ', 'A-100')).toBe('car-fax:A-100');
  });

  it('keeps the provider id case so distinct ids never merge', () => {
    expect(buildProviderInquiryKey('CarFax', 'ab12')).not.toBe(buildProviderInquiryKey('CarFax', 'AB12'));
  });

  it('refuses to build a key without a provider or an id', () => {
    expect(buildProviderInquiryKey('', 'A-100')).toBeNull();
    expect(buildProviderInquiryKey('CarFax', '   ')).toBeNull();
    expect(normalizeProviderName('***')).toBe('');
  });
});

describe('inquiry fingerprints', () => {
  it('needs an explicit request date and contact details', () => {
    expect(buildInquiryFingerprint({ ...base, requestDate: '' })).toBeNull();
    expect(buildInquiryFingerprint({ requestDate: '2026-10-22T09:28:00-06:00' })).toBeNull();
    expect(buildInquiryFingerprint({ ...base, requestDate: '2026-10-22T09:28:00-06:00' })).toMatch(/^inquiry:/);
  });

  it('never treats a request date alone as the identity of an inquiry', () => {
    const date = '2026-10-22T09:28:00-06:00';
    const first = buildInquiryFingerprint({ ...base, requestDate: date });
    const otherCustomer = buildInquiryFingerprint({ ...base, email: 'other@example.com', phone: '801-555-0142', requestDate: date });
    const otherVehicle = buildInquiryFingerprint({ ...base, vehicle: { year: '2019', make: 'Toyota', model: 'Camry' }, requestDate: date });
    expect(new Set([first, otherCustomer, otherVehicle]).size).toBe(3);
  });

  it('gives the same inquiry the same fingerprint across formatting differences', () => {
    const a = buildInquiryFingerprint({ ...base, requestDate: '2026-10-22T09:28:00-06:00' });
    const b = buildInquiryFingerprint({
      ...base,
      provider: ' carfax ',
      email: 'pat.lee@example.com',
      phone: '+1 385 503 5869',
      comments: '  is it   still available? ',
      requestDate: '2026-10-22T15:28:00.000Z',
    });
    expect(a).toBe(b);
  });

  it('separates two genuine inquiries that differ only by request date', () => {
    expect(buildInquiryFingerprint({ ...base, requestDate: '2026-10-01T10:00:00Z' })).not.toBe(
      buildInquiryFingerprint({ ...base, requestDate: '2026-10-22T10:00:00Z' }),
    );
  });

  it('does not build a permanent fingerprint from a date with no time of day', () => {
    expect(buildInquiryFingerprint({ ...base, requestDate: '2026-10-22' })).toBeNull();
    expect(buildInquiryFingerprint({ ...base, requestDate: '10/22/2026' })).toBeNull();
    expect(requestDateIdentity('2026-10-22')).toBe('');
  });

  it('keeps a zone-less request date as written instead of reading it in the server time zone', () => {
    expect(requestDateIdentity('2026-10-22T09:28:00')).toBe('local:2026-10-22t09:28:00');
    expect(requestDateIdentity(' 10/22/2026  9:28 AM ')).toBe('local:10/22/2026 9:28 am');
    expect(buildInquiryFingerprint({ ...base, requestDate: '2026-10-22T09:28:00' })).toBe(
      buildInquiryFingerprint({ ...base, requestDate: '2026-10-22T09:28:00 ' }),
    );
  });

  it('reads request dates with an explicit zone as the same instant', () => {
    expect(requestDateIdentity('Thu, 22 Oct 2026 09:28:00 -0600')).toBe('2026-10-22T15:28:00.000Z');
    expect(requestDateIdentity('2026-10-22T15:28:00Z')).toBe('2026-10-22T15:28:00.000Z');
  });

  it('builds a content key without a date for the short duplicate window', () => {
    expect(buildInquiryContentKey(base)).toMatch(/^content:/);
    expect(buildInquiryContentKey({ ...base, requestDate: 'anything' } as any)).toBe(buildInquiryContentKey(base));
    expect(buildInquiryContentKey({ comments: 'no contact' })).toBeNull();
  });
});

describe('vehicle key', () => {
  it('prefers VIN, then stock, then year/make/model', () => {
    expect(inquiryVehicleKey({ vin: '1hgcm82633a004352', stock: 'S1', year: '2022' })).toBe('vin:1HGCM82633A004352');
    expect(inquiryVehicleKey({ stock: ' S1 ', year: '2022' })).toBe('stock:s1');
    expect(inquiryVehicleKey({ year: '2022', make: 'Honda', model: 'Civic' })).toBe('ymm:2022|honda|civic');
    expect(inquiryVehicleKey(null)).toBe('');
  });
});
