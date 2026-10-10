import { CUSTOMER_IDENTITY_INDEXES, IDENTITY_SCHEMA_OPTIONS } from '../../src/constants/customerIdentityIndexes';
import { isObsoleteCustomerEmailIndex, matchesIdentityIndex } from '../../src/services/customerIdentityIndexes.service';

const keyIndex = CUSTOMER_IDENTITY_INDEXES.find(index => index.name === 'organizationId_1_identityCreationKey_1')!;
const stored = (extra: Record<string, unknown> = {}) => ({ v: 2, name: keyIndex.name, key: keyIndex.key, unique: true, partialFilterExpression: keyIndex.partialFilterExpression, ...extra }) as any;

test('manifest has ten definitions and disables automatic DDL in every environment', () => {
  expect(CUSTOMER_IDENTITY_INDEXES).toHaveLength(10);
  expect(IDENTITY_SCHEMA_OPTIONS).toEqual({ autoIndex: false, autoCreate: false });
  expect(CUSTOMER_IDENTITY_INDEXES.filter(index => index.collection === 'leads').every(index => !index.unique)).toBe(true);
});

test('equivalent definitions accept a historical name but preserve exact ordered keys and constraints', () => {
  expect(matchesIdentityIndex(stored({ name: 'equivalent_existing_index' }), keyIndex)).toBe(true);
  expect(matchesIdentityIndex(stored({ key: { identityCreationKey: 1, organizationId: 1 } }), keyIndex)).toBe(false);
});

test.each([
  { unique: false }, { sparse: true }, { hidden: true }, { expireAfterSeconds: 60 },
  { partialFilterExpression: undefined }, { partialFilterExpression: { identityCreationKey: { $exists: true } } },
  { collation: { locale: 'en', strength: 2 } }, { key: { organizationId: -1, identityCreationKey: 1 } },
  { buildUUID: 'in-progress' }, { prepareUnique: true },
])('rejects incompatible index properties %j', properties => {
  expect(matchesIdentityIndex(stored(properties), keyIndex)).toBe(false);
});

test('only the precise obsolete full Customer email constraint is eligible for removal', () => {
  const original = { v: 2, key: { organizationId: 1, email: 1 }, unique: true } as any;
  expect(isObsoleteCustomerEmailIndex(original)).toBe(true);
  expect(isObsoleteCustomerEmailIndex({ ...original, sparse: true })).toBe(false);
  expect(isObsoleteCustomerEmailIndex({ ...original, partialFilterExpression: { email: { $type: 'string' } } })).toBe(false);
  expect(isObsoleteCustomerEmailIndex({ ...original, key: { email: 1, organizationId: 1 } })).toBe(false);
});
