import { createLoadSchema, updateLoadSchema } from '../../src/validations/load.validation';
import { registerSchema } from '../../src/validations/auth.validation';
import { describeValidationIssues } from '../../src/utils/userMessages';
import { mapKnownError } from '../../src/utils/errorMapping';

const goodLoad = {
  postType: 'load-board',
  pickupLocation: { address: '1 Main St', city: 'Ogden', state: 'UT', zip: '84401' },
  deliveryLocation: { address: '2 Elm St', city: 'Boise', state: 'ID', zip: '83702' },
  vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
  trailerType: 'open_2car',
};

const messageFor = (schema: any, input: unknown) => {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error('expected the input to be refused');
  return describeValidationIssues(parsed.error.issues);
};

describe('describeValidationIssues', () => {
  it('names a missing field in the words of the form, never the library wording', () => {
    const { address: _address, ...noAddress } = goodLoad.pickupLocation;
    const message = messageFor(createLoadSchema, { ...goodLoad, pickupLocation: noAddress });
    expect(message).toBe('Please fix the following: Pickup street address is missing.');
  });

  it('explains numbers, lengths and choices in plain words', () => {
    expect(messageFor(createLoadSchema, { ...goodLoad, pricing: { pricePerMile: 'abc' } })).toBe(
      'Please fix the following: Price per mile must be a number.',
    );
    expect(messageFor(createLoadSchema, { ...goodLoad, pricing: { pricePerMile: 5000 } })).toBe(
      'Please fix the following: Price per mile can be at most 1000.',
    );
    expect(messageFor(createLoadSchema, { ...goodLoad, vehicles: [{ year: 2020.5 }] })).toBe(
      'Please fix the following: Vehicle 1 year must be a whole number.',
    );
    expect(
      messageFor(createLoadSchema, { ...goodLoad, deliveryLocation: { ...goodLoad.deliveryLocation, phone: '5'.repeat(40) } }),
    ).toBe('Please fix the following: Delivery phone number can be at most 30 characters.');
    expect(
      messageFor(createLoadSchema, { ...goodLoad, pickupLocation: { ...goodLoad.pickupLocation, locationType: 'farm' } }),
    ).toBe('Please fix the following: Choose a valid pickup location type.');
  });

  it('keeps the messages a schema writes for people, labelled with the part of the form', () => {
    expect(
      messageFor(updateLoadSchema, {
        pickupLocation: { ...goodLoad.pickupLocation, city: '' },
        expectedUpdatedAt: new Date().toISOString(),
      }),
    ).toBe('Please fix the following: Pickup: City is required.');
  });

  it('lists every missing field of an empty sign-up form', () => {
    expect(messageFor(registerSchema, {})).toBe(
      'Please fix the following: Name is missing. Email address is missing. Password is missing.',
    );
    expect(messageFor(createLoadSchema, { ...goodLoad, vehicles: undefined })).toBe(
      'Please fix the following: Vehicles: add at least one.',
    );
  });

  it('never shows library wording for any refused load field', () => {
    const inputs = [
      {},
      { ...goodLoad, pickupLocation: { city: 'Ogden' } },
      { ...goodLoad, vehicles: [{ year: 'abcd', condition: 'Wrecked' }] },
      { ...goodLoad, trailerType: 'spaceship', dates: { firstAvailable: 'soon' } },
      { ...goodLoad, pricing: { carrierPayAmount: -5, copCodAmount: 'x' }, additionalInfo: { notes: 'x'.repeat(5000) } },
    ];
    for (const input of inputs) {
      expect(messageFor(createLoadSchema, input)).not.toMatch(/Invalid input|expected|received|Too (small|big)|Invalid option/);
    }
  });
});

describe('database validation errors', () => {
  it('says what is wrong with each field without repeating the value', () => {
    const mapped = mapKnownError({
      name: 'ValidationError',
      errors: {
        maxVehicleCapacity: { path: 'maxVehicleCapacity', kind: 'max', properties: { max: 20 }, value: 50 },
        'vehicles.1.make': { path: 'vehicles.1.make', kind: 'maxlength', properties: { maxlength: 80 } },
        serviceRadius: { path: 'serviceRadius', kind: 'Number', value: 'far' },
      },
    });
    expect(mapped).toMatchObject({ statusCode: 400, errorType: 'VALIDATION_ERROR' });
    expect(mapped?.message).toBe(
      'Please fix the following: Number of vehicles your trailer carries can be at most 20. Vehicle 2 make can be at most 80 characters. Service radius must be a number.',
    );
    expect(mapped?.message).not.toMatch(/50|far/);
  });
});
