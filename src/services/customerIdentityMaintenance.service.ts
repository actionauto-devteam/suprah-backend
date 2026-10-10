import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { CUSTOMER_IDENTITY_INDEXES } from '../constants/customerIdentityIndexes';
import { IDENTITY_COLLECTIONS, IdentityCollections, matchesIdentityIndex, readIdentityIndexes, verifyCustomerIdentityIndexes } from './customerIdentityIndexes.service';

export function assertLocalIdentityDatabase() {
  const connection = mongoose.connection;
  if (connection.readyState !== 1 || connection.host !== '127.0.0.1' || connection.port !== 27018 || connection.name !== 'suprah_dev') {
    throw new Error('Identity maintenance requires 127.0.0.1:27018/suprah_dev');
  }
}

type Step = { id: string; status: 'started' | 'succeeded' | 'failed'; detail: unknown };
type PreparationReport = {
  runId: string;
  dryRun: boolean;
  startedAt: string;
  ready: boolean;
  steps: Step[];
};
export class IdentityIndexPreparationError extends Error {
  constructor(message: string, public report: PreparationReport) { super(message); }
}

async function inspectIdentityData(collections: IdentityCollections) {
  const db = mongoose.connection.db!;
  const conflicts: Array<{ collection: string; kind: string; samples: unknown[] }> = [];
  const warnings: Array<{ collection: string; field: string; count: number }> = [];
  for (const [collection, field, match] of [
    ['customers', 'email', { email: { $type: 'string', $gt: '' } }],
    ['customers', 'identityCreationKey', { identityCreationKey: { $type: 'string' } }],
    ['customeridentitylocks', 'organizationId', {}],
  ] as const) {
    const samples = await db.collection(collections[collection]).aggregate([
      { $match: match },
      { $group: { _id: { organizationId: '$organizationId', value: `$${field}` }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 20 },
    ], { maxTimeMS: 5000 }).toArray();
    if (samples.length) conflicts.push({ collection: collections[collection], kind: `duplicate_${field}`, samples });
  }
  for (const field of ['email', 'identityCreationKey']) {
    const count = await db.collection(collections.customers).countDocuments({ [field]: { $type: 'string', $regex: /^\s*$/ } }, { maxTimeMS: 5000 });
    if (count) warnings.push({ collection: collections.customers, field, count });
    const samples = await db.collection(collections.customers).aggregate([
      { $match: { [field]: { $exists: true } } },
      { $match: { $expr: { $not: { $in: [{ $type: `$${field}` }, ['string', 'null']] } } } },
      { $project: { _id: 1, organizationId: 1 } }, { $limit: 20 },
    ], { maxTimeMS: 5000 }).toArray();
    if (samples.length) conflicts.push({ collection: collections.customers, kind: `invalid_${field}_type`, samples });
  }
  const invalidLocks = await db.collection(collections.customeridentitylocks).aggregate([
    { $match: { $expr: { $or: [{ $ne: [{ $type: '$organizationId' }, 'string'] }, { $eq: ['$organizationId', ''] }] } } },
    { $project: { _id: 1, organizationId: 1 } }, { $limit: 20 },
  ], { maxTimeMS: 5000 }).toArray();
  if (invalidLocks.length) conflicts.push({ collection: collections.customeridentitylocks, kind: 'invalid_lock_organization', samples: invalidLocks });
  for (const name of Object.values(collections)) {
    const collection = await db.listCollections({ name }, { nameOnly: false }).next();
    if (collection?.options?.collation && collection.options.collation.locale !== 'simple') conflicts.push({ collection: name, kind: 'unsupported_collection_collation', samples: [collection.options.collation] });
  }
  return { conflicts, warnings };
}

export async function prepareLocalCustomerIdentityIndexes(apply = false, options: {
  collections?: IdentityCollections;
  onStep?: (step: Step & { runId: string }) => void;
} = {}) {
  assertLocalIdentityDatabase();
  const collections = options.collections || IDENTITY_COLLECTIONS;
  const report: PreparationReport = { runId: randomUUID(), dryRun: !apply, startedAt: new Date().toISOString(), ready: false, steps: [] };
  const step = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    try {
      options.onStep?.({ id, status: 'started', detail: null, runId: report.runId });
      const detail = await operation();
      const result: Step = { id, status: 'succeeded', detail };
      report.steps.push(result);
      options.onStep?.({ ...result, runId: report.runId });
      return detail;
    } catch (error) {
      const result: Step = { id, status: 'failed', detail: { message: (error as Error).message, code: (error as { code?: number }).code } };
      report.steps.push(result);
      options.onStep?.({ ...result, runId: report.runId });
      throw new IdentityIndexPreparationError(`Identity index preparation stopped at ${id}`, report);
    }
  };
  const before = await step('inventory', () => verifyCustomerIdentityIndexes(collections));
  const data = await step('preflight', () => inspectIdentityData(collections));
  if (!apply) { report.ready = before.ready && !data.conflicts.length; return report; }
  await step('validate-preflight', async () => {
    if (data.conflicts.length || before.required.some(index => index.state === 'incorrect')) throw new Error('Conflicting data or index definitions require operator review; no indexes changed');
    return { validated: true };
  });
  for (const expected of CUSTOMER_IDENTITY_INDEXES) {
    await step(`index:${expected.collection}:${expected.name}`, async () => {
      const existing = await readIdentityIndexes(collections);
      const match = existing[expected.collection].find(index => matchesIdentityIndex(index, expected));
      if (match) return { action: 'already-present', name: match.name };
      const collection = mongoose.connection.db!.collection(collections[expected.collection]);
      await collection.createIndex(expected.key, {
        name: expected.name, ...(expected.unique ? { unique: true } : {}),
        ...(expected.partialFilterExpression ? { partialFilterExpression: expected.partialFilterExpression } : {}),
      });
      const verified = (await readIdentityIndexes(collections))[expected.collection].find(index => matchesIdentityIndex(index, expected));
      if (!verified) throw new Error('Created index did not match required definition');
      return { action: 'created', name: verified.name };
    });
  }
  const prerequisites = await step('verify-prerequisites', async () => {
    const result = await verifyCustomerIdentityIndexes(collections);
    if (result.required.some(index => index.state !== 'present')) throw new Error('Required indexes are not ready; obsolete index retained');
    return result;
  });
  for (const name of prerequisites.obsolete) {
    await step(`remove-obsolete:${name}`, async () => {
      const current = await verifyCustomerIdentityIndexes(collections);
      if (current.required.some(index => index.state !== 'present')) throw new Error('Prerequisite changed; obsolete index retained');
      if (current.obsolete.includes(name)) await mongoose.connection.db!.collection(collections.customers).dropIndex(name);
      return { name, action: 'obsolete-removed' };
    });
  }
  const final = await step('verify-final', async () => {
    const result = await verifyCustomerIdentityIndexes(collections);
    if (!result.ready) throw new Error('Final identity index verification failed');
    return result;
  });
  report.ready = final.ready;
  return report;
}
