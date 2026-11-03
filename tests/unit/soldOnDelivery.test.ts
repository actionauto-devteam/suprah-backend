/**
 * Create Managed Load asks whether the car is sold to the person receiving
 * it. The answer is optional (older forms and loads without stock cars leave
 * it out), must be a yes or no, and can be changed while editing the load.
 */
import { createLoadSchema, updateLoadSchema } from '../../src/validations/load.validation';

const goodLoad = {
  postType: 'load-board',
  pickupLocation: { address: '1 Main St', city: 'Ogden', state: 'UT', zip: '84401' },
  deliveryLocation: { address: '2 Elm St', city: 'Boise', state: 'ID', zip: '83702' },
  vehicles: [{ year: 2020, make: 'Toyota', model: 'Camry', condition: 'Operable' }],
  trailerType: 'open_2car',
};

describe('soldOnDelivery', () => {
  it('is accepted as yes or no when creating a load, and can be left out', () => {
    expect(createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: true }).success).toBe(true);
    expect(createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: false }).success).toBe(true);
    expect(createLoadSchema.safeParse(goodLoad).success).toBe(true);
    const parsed: any = createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: true });
    expect(parsed.data.soldOnDelivery).toBe(true);
  });

  it('refuses anything that is not a yes or no', () => {
    const parsed = createLoadSchema.safeParse({ ...goodLoad, soldOnDelivery: 'yes' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe('Choose whether the car is sold to the person receiving it.');
  });

  it('can be changed while editing a load', () => {
    const edit = { soldOnDelivery: true, expectedUpdatedAt: new Date().toISOString() };
    expect(updateLoadSchema.safeParse(edit).success).toBe(true);
  });
});
