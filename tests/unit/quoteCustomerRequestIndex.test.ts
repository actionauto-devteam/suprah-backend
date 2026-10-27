/**
 * The database allows only one pending customer-portal request per customer,
 * vehicle and destination, so simultaneous requests from two devices can't
 * both be saved. Staff quotes (no source) are never covered by the rule.
 */
import Quote from '../../src/models/Quote.model';

describe('Quote: one pending customer request', () => {
  it('is a unique rule limited to pending customer-portal requests', () => {
    const rule = Quote.schema.indexes().find(([, options]) => options?.name === 'one_pending_customer_request');
    expect(rule).toBeDefined();
    const [fields, options] = rule!;
    expect(fields).toEqual({ requestedBy: 1, vehicleId: 1, toZip: 1 });
    expect(options).toMatchObject({
      unique: true,
      partialFilterExpression: { source: 'customer_portal', status: 'pending' },
    });
  });
});
