import mongoose from 'mongoose';
import Customer from '../src/models/Customer.model';
import { listCustomerRecords } from '../src/services/customerRecords.service';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';

const orgId = new mongoose.Types.ObjectId().toString();
const otherOrgId = new mongoose.Types.ObjectId().toString();
const createdBy = new mongoose.Types.ObjectId();

const shownName = (customer: { firstName: string; lastName: string }) =>
  [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Unnamed customer';

const names = async (query: Record<string, unknown>, org = orgId) =>
  (await listCustomerRecords(org, query)).customers.map(shownName);

const EXPECTED = ['Amy Abbott', 'amy Brown', 'Ann Zed', 'Anna Adams', 'Bob', 'brenda Young', 'Carl Cole', 'Zach Adams'];

describe('Customer Records Name A-Z sort (real database)', () => {
  beforeAll(async () => {
    const db = mongoose.connection.db!;
    for (const index of CUSTOMER_IDENTITY_INDEXES) {
      await db.collection(index.collection).createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
      });
    }
    const people: Array<[string, string]> = [
      ['Zach', 'Adams'],
      ['Carl', 'Cole'],
      ['amy', 'Brown'],
      ['Bob', ''],
      ['Anna', 'Adams'],
      ['brenda', 'Young'],
      ['Ann', 'Zed'],
      ['Amy', 'Abbott'],
    ];
    for (const [firstName, lastName] of people) {
      await Customer.create({ organizationId: orgId, createdBy, firstName, lastName, source: 'manual' });
    }
    await Customer.create({ organizationId: orgId, createdBy, firstName: 'Aaron', lastName: 'Inactive', source: 'manual', isActive: false });
    await Customer.create({ organizationId: otherOrgId, createdBy, firstName: 'Aardvark', lastName: 'Other', source: 'manual' });
    await Customer.collection.insertOne({ organizationId: orgId, createdBy, firstName: '', lastName: '', source: 'manual', isActive: true, createdAt: new Date(), updatedAt: new Date() });
  });

  it('orders customers by the name shown in the list, ignoring capital letters', async () => {
    const result = await listCustomerRecords(orgId, { sort: 'name' });
    expect(result.sort).toBe('name');
    expect(result.total).toBe(9);
    expect(result.customers.map(shownName)).toEqual([...EXPECTED, 'Unnamed customer']);
  });

  it('keeps the same A-Z order across every page', async () => {
    const pages: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await listCustomerRecords(orgId, { sort: 'name', limit: 2, page });
      expect(result.pages).toBe(5);
      pages.push(...result.customers.map(shownName));
    }
    expect(pages).toEqual([...EXPECTED, 'Unnamed customer']);
    const ids = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      for (const customer of (await listCustomerRecords(orgId, { sort: 'name', limit: 2, page })).customers) ids.add(customer.id);
    }
    expect(ids.size).toBe(9);
  });

  it('applies A-Z within a search, a status and one dealership only', async () => {
    expect(await names({ sort: 'name', search: 'amy' })).toEqual(['Amy Abbott', 'amy Brown']);
    expect(await names({ sort: 'name', status: 'inactive' })).toEqual(['Aaron Inactive']);
    expect((await names({ sort: 'name', status: 'all' }))[0]).toBe('Aaron Inactive');
    expect(await names({ sort: 'name' }, otherOrgId)).toEqual(['Aardvark Other']);
  });

  it('returns the same fields as the other sorts', async () => {
    const byName = (await listCustomerRecords(orgId, { sort: 'name', search: 'Carl' })).customers[0];
    const byNewest = (await listCustomerRecords(orgId, { sort: 'newest', search: 'Carl' })).customers[0];
    const byRecent = (await listCustomerRecords(orgId, { sort: 'recent', search: 'Carl' })).customers[0];
    expect(byName).toEqual(byNewest);
    expect(byName).toEqual(byRecent);
  });

  it('leaves Newest record ordered by when the record was added', async () => {
    const base = Date.now();
    const order = ['Carl', 'Zach', 'Amy'];
    for (const [index, firstName] of order.entries()) {
      await Customer.collection.updateOne({ organizationId: orgId, firstName }, { $set: { createdAt: new Date(base + 60_000 * (order.length - index)) } });
    }
    const newest = await names({ sort: 'newest', limit: 3 });
    expect(newest).toEqual(['Carl Cole', 'Zach Adams', 'Amy Abbott']);
  });
});
