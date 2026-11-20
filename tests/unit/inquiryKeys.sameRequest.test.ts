import {
  compareInquiryVehicles,
  inquiryHasText,
  inquiryNamesUnit,
  inquiryTextAddsNothing,
  isSameRequest,
  sameInquiryUnit,
} from '../../src/utils/inquiryKeys';

const truck = { year: '2021', make: 'Ford', model: 'F-150', vin: '1FTFW1E50MFA00001' };

describe('inquiryKeys same-request rules', () => {
  it('compares vehicles by VIN, then stock, then full year, make and model', () => {
    expect(compareInquiryVehicles(truck, { vin: '1ftfw1e50mfa00001' })).toBe('same');
    expect(compareInquiryVehicles(truck, { vin: '1FTFW1E50MFA00002' })).toBe('different');
    expect(compareInquiryVehicles({ stock: 'T-1001' }, { stock: 't1001' })).toBe('same');
    expect(compareInquiryVehicles({ year: '2021', make: 'Ford', model: 'F-150' }, { year: '2021', make: 'ford', model: 'F-150 XLT' })).toBe('same');
    expect(compareInquiryVehicles({ year: '2021', make: 'Ford', model: 'F-150' }, { year: '2020', make: 'Ford', model: 'F-150' })).toBe('different');
    expect(compareInquiryVehicles({ make: 'Ford' }, { make: 'Ford' })).toBe('unknown');
  });

  it('a later text adds nothing only when it is blank, the same, or already inside the earlier text', () => {
    expect(inquiryTextAddsNothing('Is the truck available?', '')).toBe(true);
    expect(inquiryTextAddsNothing('Is the truck available?', 'is the truck available')).toBe(true);
    expect(inquiryTextAddsNothing('Hi! Is the truck still available? I can come Saturday.', 'is the truck still available')).toBe(true);
    expect(inquiryTextAddsNothing('Is the truck available?', 'Is the truck available? Can I trade my Accord?')).toBe(false);
    expect(inquiryTextAddsNothing('', 'Can I test drive at 5?')).toBe(false);
    expect(inquiryTextAddsNothing('Is the truck available today?', 'ok')).toBe(false);
  });

  it('treats a copy of the same vehicle as the same request only when it adds no new words', () => {
    expect(isSameRequest({ vehicle: truck, comments: 'Is it available?' }, { vehicle: { vin: truck.vin }, comments: '' })).toBe(true);
    expect(isSameRequest({ vehicle: truck, comments: 'Is it available today?' }, { vehicle: truck, comments: 'is it available today' })).toBe(true);
    expect(isSameRequest({ vehicle: truck, comments: '' }, { vehicle: truck, comments: 'Can I test drive at 5?' })).toBe(false);
    expect(isSameRequest(
      { vehicle: truck, comments: 'Is it available?', sourceIds: { mailbox: 'a@x.test' } },
      { vehicle: truck, comments: 'Is it available? Trading my 2014 Accord.', sourceIds: { mailbox: 'b@x.test' } },
    )).toBe(false);
  });

  it('keeps a copy that adds a unit the earlier one did not name, but folds one that only drops it', () => {
    const camry = { year: '2020', make: 'Toyota', model: 'Camry' };
    expect(isSameRequest({ vehicle: { ...camry, stock: 'A1' }, comments: 'Is it available?' }, { vehicle: { ...camry, vin: '4T1B11HK0LU000009' }, comments: '' })).toBe(false);
    expect(isSameRequest({ vehicle: { ...camry, vin: '4T1B11HK0LU000009' }, comments: 'Is it available?' }, { vehicle: { ...camry, stock: 'A1' }, comments: '' })).toBe(false);
    expect(isSameRequest({ vehicle: camry, comments: 'Is it available?' }, { vehicle: { ...camry, vin: '4T1B11HK0LU000009' }, comments: 'Is it available?' })).toBe(false);
    expect(isSameRequest({ vehicle: { ...camry, vin: '4T1B11HK0LU000009' }, comments: 'Is it available?' }, { vehicle: camry, comments: '' })).toBe(true);
  });

  it('never matches different vehicles, or one copy with a vehicle and one without', () => {
    expect(isSameRequest({ vehicle: truck, comments: 'Interested' }, { vehicle: { vin: '2HGFC2F59LH000002' }, comments: 'Interested' })).toBe(false);
    expect(isSameRequest({ vehicle: truck, comments: 'Interested in this one' }, { comments: 'Interested in this one' })).toBe(false);
  });

  it('without vehicles, needs a non-blank later text that adds nothing', () => {
    expect(isSameRequest({ comments: 'Please call me about financing options' }, { comments: 'Please call me about financing options!' })).toBe(true);
    expect(isSameRequest({ comments: 'Please call me about financing options' }, { comments: '' })).toBe(false);
    expect(isSameRequest({ comments: 'Please call me about financing options' }, { comments: 'What hours are you open Saturday?' })).toBe(false);
  });

  it('knows when a vehicle names one exact unit', () => {
    expect(inquiryNamesUnit({ vin: truck.vin })).toBe(true);
    expect(inquiryNamesUnit({ stock: 'T1' })).toBe(true);
    expect(inquiryNamesUnit({ year: '2021', make: 'Ford', model: 'F-150' })).toBe(false);
    expect(sameInquiryUnit({ vin: truck.vin }, { vin: truck.vin.toLowerCase() })).toBe(true);
    expect(sameInquiryUnit({ vin: truck.vin }, { stock: 'T1' })).toBe(false);
    expect(sameInquiryUnit({ year: '2021', make: 'Ford', model: 'F-150' }, { year: '2021', make: 'Ford', model: 'F-150' })).toBe(false);
    expect(inquiryHasText('  ')).toBe(false);
    expect(inquiryHasText('Hi')).toBe(true);
  });
});
