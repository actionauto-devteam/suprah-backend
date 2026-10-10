import mongoose from 'mongoose';
import { CUSTOMER_IDENTITY_INDEXES, IdentityCollection, IdentityIndex } from '../constants/customerIdentityIndexes';

export type IdentityCollections = Record<IdentityCollection, string>;
export const IDENTITY_COLLECTIONS: IdentityCollections = { customers: 'customers', leads: 'leads', customeridentitylocks: 'customeridentitylocks' };
export type StoredIdentityIndex = mongoose.mongo.IndexDescriptionInfo;

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sameIndexKeys(a: Record<string, unknown>, b: Record<string, unknown>) {
  return JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));
}

export function matchesIdentityIndex(actual: StoredIdentityIndex, expected: IdentityIndex) {
  return sameIndexKeys(actual.key, expected.key)
    && Boolean(actual.unique) === Boolean(expected.unique)
    && canonical(actual.partialFilterExpression) === canonical(expected.partialFilterExpression)
    && !actual.sparse && !actual.hidden && actual.expireAfterSeconds === undefined
    && !actual.buildUUID && !actual.prepareUnique
    && (!actual.collation || actual.collation.locale === 'simple');
}

export function isObsoleteCustomerEmailIndex(index: StoredIdentityIndex) {
  return sameIndexKeys(index.key, { organizationId: 1, email: 1 }) && index.unique === true
    && !index.partialFilterExpression && !index.sparse && index.expireAfterSeconds === undefined
    && !index.buildUUID && !index.prepareUnique
    && (!index.collation || index.collation.locale === 'simple');
}

export async function readIdentityIndexes(collections: IdentityCollections = IDENTITY_COLLECTIONS) {
  if (!mongoose.connection.db || mongoose.connection.readyState !== 1) throw new Error('Connected database required for identity index verification');
  const indexes = {} as Record<IdentityCollection, StoredIdentityIndex[]>;
  for (const collection of Object.keys(collections) as IdentityCollection[]) {
    try {
      indexes[collection] = await mongoose.connection.db.collection(collections[collection]).listIndexes({ maxTimeMS: 5000 }).toArray();
    } catch (error) {
      if ((error as { code?: number }).code !== 26) throw error;
      indexes[collection] = [];
    }
  }
  return indexes;
}

export async function verifyCustomerIdentityIndexes(collections: IdentityCollections = IDENTITY_COLLECTIONS) {
  const indexes = await readIdentityIndexes(collections);
  const required = CUSTOMER_IDENTITY_INDEXES.map(expected => {
    const actual = indexes[expected.collection];
    const match = actual.find(index => matchesIdentityIndex(index, expected));
    const nameConflict = actual.find(index => index.name === expected.name && !matchesIdentityIndex(index, expected));
    const conflicting = actual.filter(index => sameIndexKeys(index.key, expected.key)
      && !matchesIdentityIndex(index, expected)
      && !(expected.collection === 'customers' && isObsoleteCustomerEmailIndex(index)));
    const state = nameConflict || conflicting.some(index => index.unique) || (!match && conflicting.length) ? 'incorrect' : match ? 'present' : 'missing';
    const observed = actual.filter(index => index.name === expected.name || sameIndexKeys(index.key, expected.key));
    return { ...expected, state, actualName: match?.name, conflicts: [...new Set([nameConflict?.name, ...conflicting.map(index => index.name)].filter(Boolean))], observed };
  });
  const obsolete = indexes.customers.filter(isObsoleteCustomerEmailIndex).map(index => index.name!);
  return { ready: required.every(index => index.state === 'present') && !obsolete.length, required, obsolete };
}

export async function assertCustomerIdentityIndexesReady() {
  const report = await verifyCustomerIdentityIndexes();
  if (!report.ready) throw new Error(`Customer identity index preparation required: ${JSON.stringify(report)}`);
  return report;
}
