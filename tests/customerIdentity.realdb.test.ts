import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import Customer from '../src/models/Customer.model';
import Lead from '../src/models/lead.model';
import CustomerIdentityLock from '../src/models/CustomerIdentityLock.model';
import { Conversation } from '../src/models/communication.model';
import customerService from '../src/services/customer.service';
import { evaluateCustomerIdentity, findUniqueCustomerByPhone, reconcileHistoricalLeads, retryPendingLeadCustomers, syncLeadCustomer } from '../src/services/customerIdentity.service';
import { prepareLocalCustomerIdentityIndexes } from '../src/services/customerIdentityMaintenance.service';
import { backfillFromLeads, syncFromLead, syncFromLeads } from '../src/controllers/customer.controller';
import { requireAdmin } from '../src/middleware/rbac.middleware';

jest.mock('../src/utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock('../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn().mockResolvedValue(undefined) } }));

const organizationId = String(new mongoose.Types.ObjectId());
const otherOrganizationId = String(new mongoose.Types.ObjectId());
const createdBy = new mongoose.Types.ObjectId();
const scopes = { organizationId: { $in: [organizationId, otherOrganizationId] } };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.orgId = req.header('x-org') || organizationId; req.orgRole = req.header('x-role') || 'admin'; req.user = { _id: createdBy } as any; next(); });
app.post('/backfill', requireAdmin, backfillFromLeads);
app.post('/sync', syncFromLead);
app.post('/sync-all', syncFromLeads);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
const customer = (data: any = {}) => Customer.create({ organizationId, createdBy, firstName: 'Identity', lastName: 'Fixture', source: 'manual', ...data });
const lead = (data: any = {}) => Lead.create({ organizationId, createdBy, firstName: 'Identity', lastName: 'Fixture', channel: 'email', source: 'Email Inquiry', ...data });
async function historical(data: any = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({ _id, organizationId: new mongoose.Types.ObjectId(organizationId), createdBy, firstName: 'Historical', lastName: 'Fixture', channel: 'email', source: 'Email Inquiry', createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-02'), ...data });
  return _id;
}

beforeAll(async () => {
  if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || mongoose.connection.name !== 'suprah_dev') throw new Error('Local DB only');
  await prepareLocalCustomerIdentityIndexes(true);
  await Promise.all([Lead.init(), CustomerIdentityLock.init()]);
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network forbidden'));
});
beforeEach(async () => {
  await Promise.all([Lead.deleteMany(scopes), Customer.deleteMany(scopes), CustomerIdentityLock.deleteMany(scopes), Conversation.deleteMany({ orgId: { $in: [organizationId, otherOrganizationId] } })]);
});
afterAll(async () => {
  if (mongoose.connection.readyState === 1) await Promise.all([Lead.deleteMany(scopes), Customer.deleteMany(scopes), CustomerIdentityLock.deleteMany(scopes), Conversation.deleteMany({ orgId: { $in: [organizationId, otherOrganizationId] } })]);
  jest.restoreAllMocks();
  await mongoose.disconnect();
});

test('tenant isolation: same contacts create separate Customers and wrong-org lookup returns null', async () => {
  const a = await lead({ phone: '8015550123', email: 'same@example.com' });
  const b = await lead({ organizationId: otherOrganizationId, phone: '(801) 555-0123', email: 'SAME@example.com' });
  expect(a.customerLink?.status).toBe('linked');
  expect(b.customerLink?.status).toBe('linked');
  expect(String(a.customerId)).not.toBe(String(b.customerId));
  expect(String((await findUniqueCustomerByPhone(organizationId, '+18015550123'))?._id)).toBe(String(a.customerId));
  expect(await findUniqueCustomerByPhone(String(new mongoose.Types.ObjectId()), '8015550123')).toBeNull();
  await expect(syncLeadCustomer(otherOrganizationId, String(a._id))).rejects.toThrow('Lead not found');
});

test('multiple Leads and concurrent retries share one Customer without duplicate transactions', async () => {
  const leads = await Promise.all(Array.from({ length: 8 }, (_, index) => lead({ email: index % 2 ? ' PERSON@Example.com ' : 'person@example.com', phone: index % 2 ? '(801) 555-0123' : '+18015550123' })));
  expect(new Set(leads.map(item => String(item.customerId))).size).toBe(1);
  expect(leads.every(item => item.customerLink?.status === 'linked')).toBe(true);
  const sourceLeadId = String((await Customer.findById(leads[0].customerId))?.sourceLeadId);
  await Promise.all(leads.flatMap(item => [syncLeadCustomer(organizationId, String(item._id)), syncLeadCustomer(organizationId, String(item._id))]));
  expect(await Customer.countDocuments({ organizationId })).toBe(1);
  const linked = await Customer.findById(leads[0].customerId);
  expect(linked?.transactions).toHaveLength(8);
  expect(linked?.stats.totalTransactions).toBe(8);
  expect(leads.map(item => String(item._id))).toContain(String(linked?.sourceLeadId));
  expect(String(linked?.sourceLeadId)).toBe(sourceLeadId);
});

test('phone-only and email-only work without invented email addresses', async () => {
  const phoneA = await lead({ phone: '8015550123' });
  const phoneB = await lead({ phone: '8015550124', email: '' });
  const emailA = await lead({ email: 'EmailOnly@example.com', phone: '' });
  const emailB = await lead({ email: ' emailonly@EXAMPLE.COM ' });
  expect(phoneA.customerLink?.status).toBe('linked');
  expect(phoneB.customerLink?.status).toBe('linked');
  expect(String(phoneA.customerId)).not.toBe(String(phoneB.customerId));
  expect(String(emailA.customerId)).toBe(String(emailB.customerId));
  expect((await Customer.findById(phoneA.customerId))?.email).toBeUndefined();
});

test('compatible missing contact enrichment supports email-only then phone-only intake', async () => {
  const first = await lead({ email: 'person@example.com' });
  const both = await lead({ email: 'PERSON@example.com', phone: '(801) 555-0123' });
  const phone = await lead({ phone: '+18015550123' });
  expect(String(first.customerId)).toBe(String(both.customerId));
  expect(String(phone.customerId)).toBe(String(first.customerId));
  expect((await Customer.findById(first.customerId))?.normalizedPhone).toBe('+18015550123');
});

test('raw legacy contacts normalize without suffix matching or an arbitrary 500-customer cutoff', async () => {
  await Customer.collection.insertOne({ organizationId, createdBy, firstName: 'Legacy', lastName: '', email: '  PERSON@Example.com ', phone: '(801) 555-0123', isActive: true });
  const item = await lead({ email: 'person@example.com', phone: '+18015550123' });
  expect(item.customerLink?.status).toBe('linked');
  expect(await Customer.countDocuments({ organizationId })).toBe(1);
  await customer({ phone: '+49 30 12345678' });
  expect(await findUniqueCustomerByPhone(organizationId, '+13012345678')).toBeNull();
});

test('ambiguous contacts do not select a Customer or create another one', async () => {
  const a = await customer({ phone: '8015550123' });
  const b = await customer({ phone: '(801) 555-0123' });
  const item = await lead({ phone: '+18015550123' });
  expect(item.customerId).toBeUndefined();
  expect(item.customerLink?.status).toBe('ambiguous');
  expect(new Set(item.customerLink?.candidateIds?.map(String))).toEqual(new Set([String(a._id), String(b._id)]));
  expect(await findUniqueCustomerByPhone(organizationId, '8015550123')).toBeNull();
  expect(await Customer.countDocuments({ organizationId })).toBe(2);
});

test('email/phone disagreements and inactive Customers remain explicit conflicts', async () => {
  await customer({ email: 'a@example.com', phone: '8015550123' });
  const conflict = await lead({ email: 'b@example.com', phone: '8015550123' });
  expect(conflict.customerLink?.status).toBe('conflict');
  expect(conflict.customerId).toBeUndefined();
  await customer({ phone: '8015550124', isActive: false });
  const inactive = await lead({ phone: '8015550124' });
  expect(inactive.customerLink?.reason).toBe('inactive_customer');
});

test('contact edits never silently reassign the existing relationship or history', async () => {
  const item = await lead({ email: 'old@example.com', phone: '8015550123', notes: [{ text: 'Preserved note' }], location: 'Orem', status: 'Contacted' });
  const id = item.customerId;
  const changed = await Lead.findOneAndUpdate({ _id: item._id, organizationId }, { $set: { email: 'different@example.com' } }, { new: true });
  expect(changed?.customerLink?.status).toBe('conflict');
  expect(String(changed?.customerId)).toBe(String(id));
  expect(changed?.notes?.[0].text).toBe('Preserved note');
  expect(changed?.location).toBe('Orem');
  expect(changed?.status).toBe('Contacted');
  const restored = await Lead.findOneAndUpdate({ _id: item._id, organizationId }, { $set: { email: 'old@example.com' } }, { new: true });
  expect(restored?.customerLink?.status).toBe('linked');
  expect((await Customer.findById(id))?.transactions).toHaveLength(1);
});

test('Customer edits trigger relationship revalidation, cannot alter tenant/provenance, and linked deletion is blocked', async () => {
  const item = await lead({ email: 'old@example.com', phone: '8015550123' });
  const updated = await customerService.updateCustomer(String(item.customerId), organizationId, { email: 'new@example.com', organizationId: otherOrganizationId, sourceLeadId: new mongoose.Types.ObjectId() });
  expect(updated?.organizationId).toBe(organizationId);
  expect(String(updated?.sourceLeadId)).toBe(String(item._id));
  expect((await Lead.findById(item._id))?.customerLink?.status).toBe('conflict');
  await expect(customerService.deleteCustomer(String(item.customerId), organizationId)).rejects.toMatchObject({ statusCode: 409 });
  expect(await customerService.updateCustomer(String(item.customerId), otherOrganizationId, { firstName: 'Wrong org' })).toBeNull();
});

test('invalid, missing, Demo and vendor-only contact information are not guessed', async () => {
  const items = await Promise.all([lead({}), lead({ email: 'invalid', phone: '5550123' }), lead({ source: 'Demo', phone: '8015550123' }), lead({ email: 'vendor@example.com', identityEmailExcluded: true })]);
  expect(items.every(item => item.customerLink?.status === 'unresolved')).toBe(true);
  expect(await Customer.countDocuments({ organizationId })).toBe(0);
  const phone = await lead({ email: 'vendor@example.com', identityEmailExcluded: true, phone: '8015550123', channel: 'adf' });
  expect(phone.customerLink?.status).toBe('linked');
  expect((await Customer.findById(phone.customerId))?.email).toBeUndefined();
  expect(phone.email).toBe('vendor@example.com');
});

test.each(['email', 'sms', 'phone', 'web', 'webchat', 'adf'])('%s Lead.create intake uses the same linking foundation', async channel => {
  const item = await lead({ channel, phone: '8015550123' });
  expect(item.customerLink?.status).toBe('linked');
  expect((await Customer.findById(item.customerId))?.organizationId).toBe(organizationId);
});

test('manual save and atomic ADF/Gmail upserts link once, including repeat delivery', async () => {
  const manual = new Lead({ organizationId, createdBy, email: 'same@example.com', source: 'Manual Entry' });
  await manual.save();
  const filter = { organizationId, messageId: 'phase1-fixture' };
  const update = { $setOnInsert: { organizationId, createdBy, email: 'same@example.com', channel: 'adf', source: 'Third-Party Lead' } };
  const a = await Lead.findOneAndUpdate(filter, update, { upsert: true, new: true, includeResultMetadata: true });
  const b = await Lead.findOneAndUpdate(filter, update, { upsert: true, new: true, includeResultMetadata: true });
  expect(a.value?.customerLink?.status).toBe('linked');
  expect(String(a.value?.customerId)).toBe(String(manual.customerId));
  expect(String(a.value?._id)).toBe(String(b.value?._id));
  expect((await Customer.findById(manual.customerId))?.transactions).toHaveLength(2);
});

test('retry worker processes pending runtime Leads, not untouched historical records', async () => {
  const item = await lead({ phone: '8015550123' });
  const old = await historical({ phone: '8015550124' });
  await Lead.updateOne({ _id: item._id }, { $set: { 'customerLink.status': 'retry', 'customerLink.nextRetryAt': new Date(0) } }, { timestamps: false });
  await retryPendingLeadCustomers();
  expect((await Lead.findById(item._id))?.customerLink?.status).toBe('linked');
  expect((await Lead.findById(old))?.customerId).toBeUndefined();
  expect((await Customer.findById(item.customerId))?.transactions).toHaveLength(1);
});

test('historical preview is read-only; apply is scoped, rerunnable, and never creates Customers for unmatched Leads', async () => {
  const existing = await customer({ phone: '(801) 555-0123', email: 'person@example.com' });
  const match = await historical({ phone: '+18015550123', email: 'PERSON@example.com' });
  const missing = await historical({ phone: '8015550124' });
  const untouched = await historical({ organizationId: new mongoose.Types.ObjectId(otherOrganizationId), phone: '8015550123' });
  const before = await Lead.collection.findOne({ _id: match });
  const preview = await reconcileHistoricalLeads(organizationId);
  expect(preview.results.find(result => result.leadId === String(match))?.customerId).toBe(String(existing._id));
  expect(await Lead.collection.findOne({ _id: match })).toEqual(before);
  expect(await CustomerIdentityLock.countDocuments({ organizationId })).toBe(0);
  await reconcileHistoricalLeads(organizationId, { apply: true });
  await reconcileHistoricalLeads(organizationId, { apply: true });
  expect(String((await Lead.findById(match))?.customerId)).toBe(String(existing._id));
  expect((await Lead.findById(missing))?.customerLink?.status).toBe('unresolved');
  expect((await Lead.collection.findOne({ _id: untouched }))?.customerLink).toBeUndefined();
  expect((await Lead.findById(match))?.updatedAt).toEqual(before?.updatedAt);
  expect((await Customer.findById(existing._id))?.transactions).toHaveLength(1);
  expect(await Customer.countDocuments({ organizationId })).toBe(1);
});

test('historical ambiguous and provenance conflicts are reported without guessing', async () => {
  await customer({ phone: '8015550123' });
  await customer({ phone: '+18015550123' });
  const ambiguous = await historical({ phone: '8015550123' });
  await customer({ phone: '8015550124' });
  const conflict = await historical({ phone: '8015550124' });
  await customer({ phone: '8015550125', sourceLeadId: conflict });
  const report = await reconcileHistoricalLeads(organizationId, { apply: true });
  expect(report.results.find(result => result.leadId === String(ambiguous))?.status).toBe('ambiguous');
  expect(report.results.find(result => result.leadId === String(conflict))?.reason).toBe('existing_relationship_disagrees');
  expect((await Lead.findById(ambiguous))?.customerId).toBeUndefined();
  expect((await Lead.findById(conflict))?.customerId).toBeUndefined();
});

test('invalid cross-org customerId is quarantined, never dereferenced as a valid relationship', async () => {
  const foreign = await customer({ organizationId: otherOrganizationId, phone: '8015550123' });
  const id = await historical({ phone: '8015550123', customerId: foreign._id });
  const result = await syncLeadCustomer(organizationId, String(id));
  expect(result.reason).toBe('invalid_customer_reference');
  expect((await Lead.findById(id))?.customerId).toBeUndefined();
  expect(await Customer.countDocuments({ organizationId })).toBe(0);
});

test('manual Customer creation is concurrency-safe and rejects ambiguous identity edits', async () => {
  const input = { organizationId, createdBy: String(createdBy), firstName: 'Manual', lastName: '', email: '', phone: '(801) 555-0123', source: 'manual' as const };
  const results = await Promise.all([customerService.createCustomer(input), customerService.createCustomer(input)]);
  expect(results.filter(result => result.isNew)).toHaveLength(1);
  expect(String(results[0].customer._id)).toBe(String(results[1].customer._id));
  const another = await customer({ phone: '8015550124' });
  await expect(customerService.updateCustomer(String(another._id), organizationId, { phone: '8015550123' })).rejects.toMatchObject({ statusCode: 409 });
});

test('interrupted transaction attachment heals on retry without another Customer or duplicate history', async () => {
  const original = Customer.updateOne.bind(Customer);
  let fail = true;
  const update = jest.spyOn(Customer, 'updateOne').mockImplementation(((...args: any[]) => {
    if (args[1]?.$push?.transactions && fail) { fail = false; return Promise.reject(new Error('Interrupted attachment')); }
    return (original as any)(...args);
  }) as any);
  let item: any;
  try { item = await lead({ phone: '8015550123' }); } finally { update.mockRestore(); }
  expect(item.customerLink.status).toBe('retry');
  expect(await Customer.countDocuments({ organizationId })).toBe(1);
  expect((await Customer.findById(item.customerId))?.transactions).toHaveLength(0);
  await syncLeadCustomer(organizationId, String(item._id));
  await syncLeadCustomer(organizationId, String(item._id));
  expect((await Lead.findById(item._id))?.customerLink?.status).toBe('linked');
  expect((await Customer.findById(item.customerId))?.transactions).toHaveLength(1);
  expect((await Customer.findById(item.customerId))?.stats.totalTransactions).toBe(1);
});

test('contact changing during synchronization is detected by compare-and-set and never silently relinked', async () => {
  const original = Lead.updateOne.bind(Lead);
  let changed = false;
  const update = jest.spyOn(Lead, 'updateOne').mockImplementation(((...args: any[]) => {
    if (args[1]?.$set?.customerLink?.status === 'linked' && !changed) {
      changed = true;
      return Lead.collection.updateOne({ _id: args[0]._id }, { $set: { email: 'changed@example.com' } })
        .then(() => (original as any)(...args));
    }
    return (original as any)(...args);
  }) as any);
  let item: any;
  try { item = await lead({ email: 'original@example.com' }); } finally { update.mockRestore(); }
  expect(item.customerLink.status).toBe('retry');
  expect(item.customerId).toBeUndefined();
  const result = await syncLeadCustomer(organizationId, String(item._id));
  expect(result.status).toBe('conflict');
  expect(await Customer.countDocuments({ organizationId })).toBe(1);
  expect((await Lead.findById(item._id))?.customerId).toBeUndefined();
});

test('deactivation quarantines linked Leads without moving their historical Customer references', async () => {
  const item = await lead({ phone: '8015550123' });
  await customerService.updateCustomer(String(item.customerId), organizationId, { isActive: false });
  expect((await Lead.findById(item._id))?.customerLink?.status).toBe('conflict');
  expect(String((await Lead.findById(item._id))?.customerId)).toBe(String(item.customerId));
  expect(await findUniqueCustomerByPhone(organizationId, '8015550123')).toBeNull();
});

test('Conversation customer linking only fills empty same-org links and never moves history', async () => {
  const id = await historical({ phone: '8015550123' });
  const wrong = await customer({ organizationId: otherOrganizationId, phone: '8015550123' });
  const local = await Conversation.create({ orgId: organizationId, customerPhone: '+18015550123', leadId: id });
  const foreign = await Conversation.create({ orgId: otherOrganizationId, customerPhone: '+18015550123', leadId: id, customerId: wrong._id });
  const result = await syncLeadCustomer(organizationId, String(id));
  expect(String((await Conversation.findById(local._id))?.customerId)).toBe(result.customerId);
  expect(String((await Conversation.findById(foreign._id))?.customerId)).toBe(String(wrong._id));
});

test('reconciliation pagination is stable and rejects invalid cursors/limits', async () => {
  const ids = [await historical(), await historical(), await historical()];
  const first = await reconcileHistoricalLeads(organizationId, { limit: 2 });
  const second = await reconcileHistoricalLeads(organizationId, { limit: 2, after: first.nextCursor! });
  expect(first.results).toHaveLength(2);
  expect(second.results.map(result => result.leadId)).toEqual([String(ids[2])]);
  await expect(reconcileHistoricalLeads(organizationId, { after: 'invalid' })).rejects.toThrow('cursor');
  await expect(reconcileHistoricalLeads(organizationId, { limit: -1 })).rejects.toThrow('limit');
});

test('backfill API defaults to preview, enforces admin and tenant scope, and preserves sync response compatibility', async () => {
  const existing = await customer({ phone: '8015550123' });
  const old = await historical({ phone: '8015550123' });
  expect((await request(app).post('/backfill').set('x-role', 'employee').send({ apply: true })).status).toBe(403);
  const preview = await request(app).post('/backfill').send({});
  expect(preview.body.data.dryRun).toBe(true);
  expect((await Lead.collection.findOne({ _id: old }))?.customerId).toBeUndefined();
  const wrongOrg = await request(app).post('/backfill').set('x-org', otherOrganizationId).send({ apply: true });
  expect(wrongOrg.body.data.results).toHaveLength(0);
  const syncAll = await request(app).post('/sync-all').send({});
  expect(syncAll.body.data).toMatchObject({ total: 1, synced: 0, skipped: 1, failed: 0, alreadySynced: 0 });
  expect((await Lead.collection.findOne({ _id: old }))?.customerId).toBeUndefined();
  expect((await request(app).post('/backfill').send({ apply: true })).body.data.dryRun).toBe(false);
  expect(String((await Lead.findById(old))?.customerId)).toBe(String(existing._id));
});

test('single sync API derives identity from stored Lead, not submitted contact fields', async () => {
  const item = await lead({ phone: '8015550123' });
  const response = await request(app).post('/sync').send({ leadId: String(item._id), email: 'different@example.com', phone: '8015550124' });
  expect(response.status).toBe(200);
  expect(response.body.data._id).toBe(String(item.customerId));
  expect(await Customer.countDocuments({ organizationId })).toBe(1);
  expect((await request(app).post('/sync').set('x-org', otherOrganizationId).send({ leadId: String(item._id) })).status).not.toBe(200);
});

test('historical aggregator sender email is not mistaken for the customer identity', async () => {
  await customer({ email: 'vendor@example.com' });
  const old = await historical({ email: 'vendor@example.com', senderEmail: 'Vendor <vendor@example.com>', centralIngestion: true });
  const result = await syncLeadCustomer(organizationId, String(old), { historical: true });
  expect(result.status).toBe('unresolved');
  expect(result.reason).toBe('untrusted_sender_contact');
  expect((await Lead.findById(old))?.customerId).toBeUndefined();
  expect((await Lead.findById(old))?.identityEmailExcluded).toBe(true);
});
