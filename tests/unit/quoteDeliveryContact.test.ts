/**
 * When a quote becomes a load, the quote's customer is the delivery stop's
 * contact, and nothing in it can stop the conversion.
 */
import { quoteDeliveryContact } from '../../src/services/quoteDeliveryContact';
import { createLoadSchema } from '../../src/validations/load.validation';

const stop = { address: '1 Main St', city: 'Orem', state: 'UT', zip: '84057' };

describe('quoteDeliveryContact', () => {
  it("uses the quote customer's name, phone and email", () => {
    expect(quoteDeliveryContact({ firstName: ' Maria ', lastName: 'Santos', phone: '(801) 555-0100', email: 'maria@example.com' })).toEqual({
      contactName: 'Maria Santos',
      phone: '(801) 555-0100',
      email: 'maria@example.com',
    });
  });

  it('leaves out what a load stop would refuse, instead of blocking', () => {
    expect(quoteDeliveryContact({ firstName: 'Maria', lastName: '', phone: '1'.repeat(31), email: 'not-an-email' })).toEqual({
      contactName: 'Maria',
    });
    expect(quoteDeliveryContact({})).toEqual({});
    expect(quoteDeliveryContact({ firstName: 'A'.repeat(200) }).contactName).toHaveLength(120);
  });

  it('always passes the same rules as Create Load', () => {
    const contact = quoteDeliveryContact({ firstName: 'A'.repeat(200), lastName: 'B', phone: '+1 801 555 0100', email: 'Maria@Example.com' });
    const parsed = createLoadSchema.safeParse({
      postType: 'load-board',
      pickupLocation: stop,
      deliveryLocation: { ...stop, ...contact },
      vehicles: [{ condition: 'Operable', year: 2021, make: 'Toyota', model: 'Camry' }],
      trailerType: 'open_2car',
      contract: { agreedToTerms: false },
      pricing: { carrierPayAmount: 900, copCodAmount: 0 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deliveryLocation).toMatchObject({ phone: '+1 801 555 0100', email: 'Maria@Example.com' });
    }
  });
});
