import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import Customer from '../src/models/Customer.model';
import Lead from '../src/models/lead.model';
import CustomerIdentityLock from '../src/models/CustomerIdentityLock.model';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';
import * as indexService from '../src/services/customerIdentityIndexes.service';
import { assertLocalIdentityDatabase, IdentityIndexPreparationError, prepareLocalCustomerIdentityIndexes } from '../src/services/customerIdentityMaintenance.service';
import { reconcileHistoricalLeads, syncLeadCustomerSafely } from '../src/services/customerIdentity.service';
import { withCustomerIdentityLock } from '../src/services/customerIdentityLock.service';

jest.mock('../src/utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const prefix = `identity_migration_${randomUUID().replace(/-/g, '')}_`;
const collections: indexService.IdentityCollections = { customers: `${prefix}customers`, leads: `${prefix}leads`, customeridentitylocks: `${prefix}locks` };
const db = () => mongoose.connection.db!;
const fixture = (name: keyof typeof collections) => db().collection(collections[name]);
const apply = () => prepareLocalCustomerIdentityIndexes(true, { collections });
const verify = () => indexService.verifyCustomerIdentityIndexes(collections);
const oldName = 'organizationId_1_email_1';
const customer = (extra: Record<string, unknown> = {}) => ({ organizationId: 'fixture-org', firstName: 'Historical', email: 'historical@example.com', phone: '(801) 555-0123', ...extra });

async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const name of Object.values(collections)) {
    const info = await db().listCollections({ name }, { nameOnly: false }).next();
    result[name] = info ? { info, indexes: await db().collection(name).listIndexes().toArray(), documents: await db().collection(name).find({}).sort({ _id: 1 }).toArray() } : null;
  }
  return result;
}

async function failBuild(indexName: string) {
  const original = mongoose.mongo.Collection.prototype.createIndex;
  return jest.spyOn(mongoose.mongo.Collection.prototype, 'createIndex').mockImplementation(async function (this: any, keys: any, options: any) {
    if (Object.values(collections).includes(this.collectionName) && options?.name === indexName) throw new Error(`Injected build failure: ${indexName}`);
    return original.call(this, keys, options);
  } as any);
}

beforeEach(async () => {
  assertLocalIdentityDatabase();
  for (const name of Object.values(collections)) {
    if (!name.startsWith(prefix)) throw new Error('Unsafe fixture collection');
    await db().collection(name).drop().catch(error => { if (error.code !== 26) throw error; });
  }
  await db().createCollection(collections.customers);
  await fixture('customers').insertOne(customer());
  await fixture('customers').createIndex({ organizationId: 1, email: 1 }, { unique: true, name: oldName });
  await fixture('customers').createIndex({ organizationId: 1, createdAt: -1 }, { name: 'existing_customer_list' });
  await db().createCollection(collections.leads);
  await fixture('leads').insertOne({ organizationId: 'fixture-org', phone: '8015550123', marker: 'do-not-reconcile' });
  await fixture('leads').createIndex({ organizationId: 1, messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $type: 'string' } }, name: 'existing_ingestion' });
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const name of Object.values(collections)) await db().collection(name).drop().catch(error => { if (error.code !== 26) throw error; });
});

test('old email index migrates only after every exact prerequisite exists, preserving history and unrelated indexes', async () => {
  const before = await snapshot();
  const report = await apply();
  expect(report.ready).toBe(true);
  const final = await verify();
  expect(final.ready).toBe(true);
  expect(final.required).toHaveLength(10);
  expect(final.required.every(index => index.state === 'present')).toBe(true);
  expect(final.obsolete).toEqual([]);
  const ids = report.steps.map(step => step.id);
  expect(ids.indexOf('verify-prerequisites')).toBeLessThan(ids.indexOf(`remove-obsolete:${oldName}`));
  const after: any = await snapshot();
  for (const name of [collections.customers, collections.leads]) {
    expect(after[name].documents).toEqual((before as any)[name].documents);
    for (const index of (before as any)[name].indexes.filter((item: any) => item.name !== oldName)) expect(after[name].indexes).toContainEqual(index);
  }
  expect((await fixture('leads').findOne({ marker: 'do-not-reconcile' }))?.customerId).toBeUndefined();
});

test('repeated preparation is idempotent, including collection options and data', async () => {
  await apply();
  const before = await snapshot();
  const repeated = await apply();
  expect(repeated.ready).toBe(true);
  expect(repeated.steps.filter(step => step.id.startsWith('index:')).every(step => (step.detail as any).action === 'already-present')).toBe(true);
  expect(await snapshot()).toEqual(before);
});

test('preview inventories conflicts without creating the missing lock collection or changing anything', async () => {
  const before = await snapshot();
  const writes = [
    jest.spyOn(mongoose.mongo.Collection.prototype, 'createIndex'),
    jest.spyOn(mongoose.mongo.Collection.prototype, 'dropIndex'),
    jest.spyOn(mongoose.mongo.Db.prototype, 'createCollection'),
    jest.spyOn(mongoose.mongo.Collection.prototype, 'insertOne'),
    jest.spyOn(mongoose.mongo.Collection.prototype, 'updateOne'),
    jest.spyOn(mongoose.mongo.Collection.prototype, 'updateMany'),
  ];
  const preview = await prepareLocalCustomerIdentityIndexes(false, { collections });
  expect(preview.dryRun).toBe(true);
  expect(preview.ready).toBe(false);
  expect(preview.steps.map(step => step.id)).toEqual(['inventory', 'preflight']);
  expect(await snapshot()).toEqual(before);
  writes.forEach(write => expect(write).not.toHaveBeenCalled());
});

test('preview on entirely missing fixture collections creates no namespaces', async () => {
  for (const name of Object.values(collections)) await db().collection(name).drop().catch(error => { if (error.code !== 26) throw error; });
  const before = await snapshot();
  const result = await prepareLocalCustomerIdentityIndexes(false, { collections });
  expect(result.ready).toBe(false);
  expect(await snapshot()).toEqual(before);
});

test.each(CUSTOMER_IDENTITY_INDEXES.map(index => [index.name]))('failure building %s retains old/unrelated indexes and successfully resumes', async name => {
  const failure = await failBuild(name);
  let error: any;
  try { await apply(); } catch (caught) { error = caught; }
  failure.mockRestore();
  expect(error).toBeInstanceOf(IdentityIndexPreparationError);
  expect(error.report.runId).toBeTruthy();
  expect(error.report.steps.at(-1)).toMatchObject({ status: 'failed' });
  expect(error.report.steps.some((step: any) => step.id.startsWith('remove-obsolete:'))).toBe(false);
  expect((await fixture('customers').listIndexes().toArray()).map(index => index.name)).toEqual(expect.arrayContaining([oldName, 'existing_customer_list']));
  expect((await fixture('leads').listIndexes().toArray()).map(index => index.name)).toContain('existing_ingestion');
  expect((await apply()).ready).toBe(true);
});

test.each(['inventory', 'verify-prerequisites', 'verify-final'])('%s verification failure stops and can resume without undoing completed steps', async stage => {
  const original = indexService.verifyCustomerIdentityIndexes;
  let call = 0;
  const failAt = stage === 'inventory' ? 1 : stage === 'verify-prerequisites' ? 2 : 4;
  const failure = jest.spyOn(indexService, 'verifyCustomerIdentityIndexes').mockImplementation(async (...args) => {
    if (++call === failAt) throw new Error('Injected verification outage');
    return original(...args);
  });
  let error: any;
  try { await apply(); } catch (caught) { error = caught; }
  failure.mockRestore();
  expect(error).toBeInstanceOf(IdentityIndexPreparationError);
  expect(error.report.steps.at(-1).id).toBe(stage);
  if (stage !== 'verify-final') expect((await fixture('customers').listIndexes().toArray()).map(index => index.name)).toContain(oldName);
  expect((await apply()).ready).toBe(true);
});

test('preflight database failure performs no mutations and resumes', async () => {
  const before = await snapshot();
  const original = mongoose.mongo.Collection.prototype.aggregate;
  const failure = jest.spyOn(mongoose.mongo.Collection.prototype, 'aggregate').mockImplementation(function (this: any, ...args: any[]) {
    if (Object.values(collections).includes(this.collectionName)) throw new Error('Injected preflight failure');
    return (original as any).apply(this, args);
  } as any);
  await expect(apply()).rejects.toMatchObject({ report: { steps: expect.arrayContaining([expect.objectContaining({ id: 'preflight', status: 'failed' })]) } });
  failure.mockRestore();
  expect(await snapshot()).toEqual(before);
  expect((await apply()).ready).toBe(true);
});

test('obsolete-index removal failure leaves all prerequisites valid and reruns safely', async () => {
  const original = mongoose.mongo.Collection.prototype.dropIndex;
  const failure = jest.spyOn(mongoose.mongo.Collection.prototype, 'dropIndex').mockImplementation(async function (this: any, name: string, ...args: any[]) {
    if (this.collectionName === collections.customers && name === oldName) throw new Error('Injected removal failure');
    return (original as any).call(this, name, ...args);
  } as any);
  await expect(apply()).rejects.toMatchObject({ report: { steps: expect.arrayContaining([expect.objectContaining({ id: `remove-obsolete:${oldName}`, status: 'failed' })]) } });
  failure.mockRestore();
  expect((await verify()).required.every(index => index.state === 'present')).toBe(true);
  expect((await verify()).obsolete).toEqual([oldName]);
  expect((await apply()).ready).toBe(true);
});

test('missing/null/empty email and creation keys follow the exact partial constraints without rewriting data', async () => {
  await fixture('customers').dropIndex(oldName);
  await fixture('customers').insertMany([
    customer({ email: undefined, identityCreationKey: undefined }), customer({ email: null, identityCreationKey: null }),
    customer({ email: '', identityCreationKey: 'unique-blank-email' }), customer({ email: '', identityCreationKey: 'another-blank-email' }),
    customer({ email: 'whitespace@example.com', identityCreationKey: '' }), customer({ email: '   ', identityCreationKey: 'whitespace' }),
  ]);
  const before = await fixture('customers').find({}).toArray();
  const report = await apply();
  expect(report.ready).toBe(true);
  expect((report.steps.find(step => step.id === 'preflight')?.detail as any).warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'email' }), expect.objectContaining({ field: 'identityCreationKey' })]));
  expect(await fixture('customers').find({}).toArray()).toEqual(before);
  await expect(fixture('customers').insertOne(customer({ email: 'second@example.com', identityCreationKey: '' }))).rejects.toMatchObject({ code: 11000 });
});

test.each([
  ['email', { email: 'duplicated@example.com' }],
  ['email', { email: '   ' }],
  ['identityCreationKey', { identityCreationKey: 'duplicate-key' }],
  ['identityCreationKey', { identityCreationKey: '' }],
])('duplicate %s values fail preflight without changing indexes/data', async (_field, values) => {
  await fixture('customers').dropIndex(oldName);
  await fixture('customers').insertMany([customer({ email: 'a@example.com', ...values }), customer({ email: 'b@example.com', ...values })]);
  const before = await snapshot();
  await expect(apply()).rejects.toMatchObject({ report: { steps: expect.arrayContaining([expect.objectContaining({ id: 'validate-preflight', status: 'failed' })]) } });
  expect(await snapshot()).toEqual(before);
  const preview = await prepareLocalCustomerIdentityIndexes(false, { collections });
  expect((preview.steps.find(step => step.id === 'preflight')?.detail as any).conflicts.length).toBeGreaterThan(0);
});

test.each([{ organizationId: 'duplicate-org' }, { organizationId: null }, { organizationId: '' }, {}])('lock uniqueness/invalid organization conflict %j fails safely', async values => {
  await fixture('customeridentitylocks').insertMany([{ ...values, owner: 'a' }, { ...values, owner: 'b' }]);
  const before = await snapshot();
  await expect(apply()).rejects.toBeInstanceOf(IdentityIndexPreparationError);
  expect(await snapshot()).toEqual(before);
});

test('duplicate appearing after preflight makes the real unique build fail and retains the old index', async () => {
  const original = mongoose.mongo.Collection.prototype.createIndex;
  const failure = jest.spyOn(mongoose.mongo.Collection.prototype, 'createIndex').mockImplementation(async function (this: any, keys: any, options: any) {
    if (this.collectionName === collections.customers && options?.name === 'organizationId_1_identityCreationKey_1') {
      await fixture('customers').insertMany([customer({ email: 'a@example.com', identityCreationKey: 'late-duplicate' }), customer({ email: 'b@example.com', identityCreationKey: 'late-duplicate' })]);
    }
    return original.call(this, keys, options);
  } as any);
  await expect(apply()).rejects.toMatchObject({ report: { steps: expect.arrayContaining([expect.objectContaining({ status: 'failed', detail: expect.objectContaining({ code: 11000 }) })]) } });
  failure.mockRestore();
  expect((await fixture('customers').listIndexes().toArray()).map(index => index.name)).toContain(oldName);
  expect(await fixture('customers').countDocuments({ identityCreationKey: 'late-duplicate' })).toBe(2);
});

test.each(CUSTOMER_IDENTITY_INDEXES.map(index => [index.collection, index.name]))('verification detects missing %s/%s', async (collection, name) => {
  await apply();
  await fixture(collection as keyof typeof collections).dropIndex(name);
  const report = await verify();
  expect(report.ready).toBe(false);
  expect(report.required.find(index => index.collection === collection && index.name === name)?.state).toBe('missing');
});

test.each([
  ['unique', { key: { organizationId: 1 }, options: {} }],
  ['keys', { key: { organizationId: -1 }, options: { unique: true } }],
  ['sparse', { key: { organizationId: 1 }, options: { unique: true, sparse: true } }],
  ['partial', { key: { organizationId: 1 }, options: { unique: true, partialFilterExpression: { owner: { $exists: true } } } }],
  ['ttl', { key: { organizationId: 1 }, options: { unique: true, expireAfterSeconds: 3600 } }],
])('verification rejects incorrect lock %s without replacing it', async (_property, definition) => {
  await fixture('customeridentitylocks').createIndex(definition.key as any, { ...definition.options, name: 'organizationId_1' } as any);
  const before = await snapshot();
  expect((await verify()).required.find(index => index.collection === 'customeridentitylocks')?.state).toBe('incorrect');
  await expect(apply()).rejects.toBeInstanceOf(IdentityIndexPreparationError);
  expect(await snapshot()).toEqual(before);
});

test('models initialize without automatic indexes/collections even on an auto-enabled connection', async () => {
  const previous = { autoIndex: mongoose.connection.config.autoIndex, autoCreate: mongoose.connection.config.autoCreate };
  mongoose.connection.config.autoIndex = true;
  mongoose.connection.config.autoCreate = true;
  try {
  for (const [name, schema, collection] of [['Customer', Customer.schema, collections.customers], ['Lead', Lead.schema, collections.leads], ['Lock', CustomerIdentityLock.schema, collections.customeridentitylocks]] as const) {
    expect(schema.options.autoIndex).toBe(false);
    expect(schema.options.autoCreate).toBe(false);
    const modelName = `${prefix}${name}`;
    const model = mongoose.model(modelName, schema.clone(), collection);
    const before = await snapshot();
    try { await model.init(); expect(await snapshot()).toEqual(before); } finally { mongoose.deleteModel(modelName); }
  }
  } finally { Object.assign(mongoose.connection.config, previous); }
});

test('an additional incompatible unique relationship constraint requires review instead of being ignored or dropped', async () => {
  await apply();
  await fixture('leads').createIndex({ organizationId: 1, customerId: 1 }, { name: 'unexpected_unique_relationship', unique: true });
  const before = await snapshot();
  expect((await verify()).required.find(index => index.name === 'organizationId_1_customerId_1')?.state).toBe('incorrect');
  await expect(apply()).rejects.toBeInstanceOf(IdentityIndexPreparationError);
  expect(await snapshot()).toEqual(before);
});

test('application identity writes and reconciliation apply fail closed without prepared indexes; preview does not migrate', async () => {
  const original = mongoose.connection.db!.collection.bind(mongoose.connection.db);
  const redirect = jest.spyOn(mongoose.connection.db!, 'collection').mockImplementation(((name: string, ...args: any[]) => original((collections as any)[name] || name, ...args)) as any);
  const operation = jest.fn();
  const before = await snapshot();
  await expect(withCustomerIdentityLock('fixture-org', operation)).rejects.toThrow('index preparation required');
  expect(operation).not.toHaveBeenCalled();
  const org = new mongoose.Types.ObjectId().toString();
  await expect(reconcileHistoricalLeads(org, { apply: true })).rejects.toThrow('index preparation required');
  expect((await reconcileHistoricalLeads(org)).dryRun).toBe(true);
  expect(await snapshot()).toEqual(before);
  const id = new mongoose.Types.ObjectId();
  await fixture('leads').insertOne({ _id: id, organizationId: new mongoose.Types.ObjectId(org), phone: '8015550123' });
  jest.spyOn(Lead, 'updateOne').mockImplementation(((filter: any, update: any) => fixture('leads').updateOne({ _id: new mongoose.Types.ObjectId(filter._id), organizationId: new mongoose.Types.ObjectId(filter.organizationId) }, update)) as any);
  expect((await syncLeadCustomerSafely(org, String(id))).status).toBe('retry');
  expect((await fixture('leads').findOne({ _id: id }))?.customerLink.status).toBe('retry');
  redirect.mockRestore();
  expect(await fixture('customers').countDocuments({})).toBe(1);
  expect(await db().listCollections({ name: collections.customeridentitylocks }).next()).toBeNull();
});
